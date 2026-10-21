//! The SQLCipher database. The backend in the WebView sends SQL with
//! parameters, D1-style, so the worker's queries port line by line.

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

use crate::error::{Error, Result};

const MIGRATIONS: &[&str] = &[
    include_str!("../../../packages/backend/migrations/0001_local.sql"),
    include_str!("../../../packages/backend/migrations/0002_fast_detection.sql"),
];

pub fn open(path: &std::path::Path, key: &[u8; 32]) -> Result<Connection> {
    let c = Connection::open(path)?;
    c.execute_batch(&format!("PRAGMA key = \"x'{}'\";", hex::encode(key)))?;
    // Fails here, not later, when the key is wrong.
    c.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(())).map_err(|_| Error::msg("database key rejected"))?;
    c.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY; PRAGMA secure_delete = ON;")?;
    migrate(&c)?;
    Ok(c)
}

fn migrate(c: &Connection) -> Result<()> {
    let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(v as usize) {
        c.execute_batch(&format!("BEGIN; {sql}\nPRAGMA user_version = {}; COMMIT;", i + 1))?;
        crate::log::info("db", &format!("schema migrated to version {}", i + 1));
    }
    Ok(())
}

fn to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(SqlValue::Integer).unwrap_or_else(|| SqlValue::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

fn from_sql(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::Number(i.into()),
        ValueRef::Real(f) => Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::String(hex::encode(b)),
    }
}

pub fn all(c: &Connection, sql: &str, params: &[Value]) -> Result<Vec<Map<String, Value>>> {
    let mut stmt = c.prepare_cached(sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.query(params_from_iter(params.iter().map(to_sql)))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut m = Map::new();
        for (i, n) in names.iter().enumerate() {
            m.insert(n.clone(), from_sql(row.get_ref(i)?));
        }
        out.push(m);
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub changes: usize,
    pub last_row_id: i64,
}

pub fn run(c: &Connection, sql: &str, params: &[Value]) -> Result<RunResult> {
    let changes = c.prepare_cached(sql)?.execute(params_from_iter(params.iter().map(to_sql)))?;
    Ok(RunResult { changes, last_row_id: c.last_insert_rowid() })
}

#[derive(Deserialize)]
pub struct Stmt {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

/// All statements in one transaction: the whole batch or nothing, like D1.
pub fn batch(c: &mut Connection, stmts: &[Stmt]) -> Result<Vec<RunResult>> {
    let tx = c.transaction()?;
    let mut out = Vec::with_capacity(stmts.len());
    for s in stmts {
        out.push(run(&tx, &s.sql, &s.params)?);
    }
    tx.commit()?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encrypted_at_rest_and_wrong_key_fails() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.db");
        {
            let c = open(&path, &[1u8; 32]).unwrap();
            run(&c, "INSERT INTO projects (id, name) VALUES (?, ?)", &[json!("p1"), json!("Tremblay 662-1934")]).unwrap();
        }
        let raw = std::fs::read(&path).unwrap();
        assert!(!raw.starts_with(b"SQLite format 3"));
        assert!(!raw.windows(8).any(|w| w == b"Tremblay"));
        assert!(open(&path, &[2u8; 32]).is_err());
        let c = open(&path, &[1u8; 32]).unwrap();
        let rows = all(&c, "SELECT id, name FROM projects", &[]).unwrap();
        assert_eq!(rows[0]["name"], json!("Tremblay 662-1934"));
    }

    #[test]
    fn batch_is_all_or_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = open(&dir.path().join("data.db"), &[1u8; 32]).unwrap();
        let stmts = vec![
            Stmt { sql: "INSERT INTO projects (id, name) VALUES ('a', 'A')".into(), params: vec![] },
            Stmt { sql: "INSERT INTO projects (id, name) VALUES ('a', 'dup')".into(), params: vec![] },
        ];
        assert!(batch(&mut c, &stmts).is_err());
        assert!(all(&c, "SELECT * FROM projects", &[]).unwrap().is_empty());
    }
}
