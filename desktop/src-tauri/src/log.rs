//! The diagnostic log: `~/.devance/logs/anonymizer.log`
//! (`%USERPROFILE%\.devance\logs` on Windows), rotated at 5 MB with four old
//! files kept. It holds ids, steps, timings, counts and errors, never document
//! content. Callers write their own messages without values; `scrub` also
//! masks quoted strings, since parsers quote the token they choked on.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_BYTES: u64 = 5 * 1024 * 1024;
const KEEP: usize = 4;
const MAX_LINE: usize = 4000;
/// The page sends a heartbeat every 20 s; this long without one means its script is stuck.
const STALL: Duration = Duration::from_secs(90);

struct Logger {
    dir: PathBuf,
    file: Mutex<Option<File>>,
}

static LOGGER: OnceLock<Logger> = OnceLock::new();

struct Beat {
    at: Instant,
    seen: bool,
    busy: bool,
    visible: bool,
    stalled: bool,
}

static BEAT: Mutex<Option<Beat>> = Mutex::new(None);

pub fn dir() -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(d) = std::env::var_os("ANON_DATA_DIR") {
        return PathBuf::from(d).join("logs");
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    home.join(".devance").join("logs")
}

fn path(dir: &std::path::Path, n: usize) -> PathBuf {
    if n == 0 {
        dir.join("anonymizer.log")
    } else {
        dir.join(format!("anonymizer.{n}.log"))
    }
}

fn open(dir: &std::path::Path) -> Option<File> {
    std::fs::create_dir_all(dir).ok()?;
    OpenOptions::new().create(true).append(true).open(path(dir, 0)).ok()
}

fn rotate(dir: &std::path::Path) {
    let _ = std::fs::remove_file(path(dir, KEEP));
    for n in (0..KEEP).rev() {
        let _ = std::fs::rename(path(dir, n), path(dir, n + 1));
    }
}

/// Starts the log, records panics, and watches the page's heartbeat.
pub fn init() {
    let _ = LOGGER.set(Logger { dir: dir(), file: Mutex::new(None) });
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        error("app", &format!("panic: {info}"));
        prev(info);
    }));
    *BEAT.lock().unwrap_or_else(|e| e.into_inner()) = Some(Beat { at: Instant::now(), seen: false, busy: false, visible: true, stalled: false });
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(10));
        let mut g = BEAT.lock().unwrap_or_else(|e| e.into_inner());
        let Some(b) = g.as_mut() else { continue };
        if b.stalled || b.at.elapsed() < STALL {
            continue;
        }
        b.stalled = true;
        let secs = b.at.elapsed().as_secs();
        let what = if !b.seen {
            "the page has not started".to_string()
        } else {
            format!("no heartbeat from the page for {secs} s ({}, window {}): its script is stuck, or the system paused a hidden window", if b.busy { "during a job" } else { "idle" }, if b.visible { "visible" } else { "hidden" })
        };
        drop(g);
        warn("watchdog", &what);
    });
}

pub fn info(source: &str, msg: &str) {
    write("INFO", source, msg);
}
pub fn warn(source: &str, msg: &str) {
    write("WARN", source, msg);
}
pub fn error(source: &str, msg: &str) {
    write("ERROR", source, msg);
}

fn write(level: &str, source: &str, msg: &str) {
    let mut msg = scrub(msg);
    if msg.len() > MAX_LINE {
        let mut cut = MAX_LINE;
        while !msg.is_char_boundary(cut) {
            cut -= 1;
        }
        msg.truncate(cut);
        msg.push_str(" […]");
    }
    let line = format!("{} {level:<5} [{source}] {}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"), msg.trim_end().replace('\n', "\n    "));
    #[cfg(debug_assertions)]
    eprint!("{line}");
    let Some(l) = LOGGER.get() else { return };
    let mut g = l.file.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() {
        *g = open(&l.dir);
    }
    let Some(f) = g.as_mut() else { return };
    let _ = f.write_all(line.as_bytes());
    if f.metadata().map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        *g = None;
        rotate(&l.dir);
        *g = open(&l.dir);
    }
}

/// Masks quoted strings: `Unexpected identifier "Tremblay"` → `Unexpected
/// identifier "…"`. Python traceback lines (`File "…/pdf.py", line 12`) keep
/// their path. A `'` inside a word ("can't", "l'adresse") is an apostrophe.
pub fn scrub(msg: &str) -> String {
    let chars: Vec<char> = msg.chars().collect();
    let mut out = String::with_capacity(msg.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let opens = c == '"' || (c == '\'' && !chars.get(i.wrapping_sub(1)).is_some_and(|p| p.is_alphanumeric()));
        if opens {
            let close = (i + 1..chars.len()).find(|&j| chars[j] == c && (c == '"' || !chars.get(j + 1).is_some_and(|n| n.is_alphanumeric())));
            if let Some(j) = close {
                let traceback = c == '"' && out.trim_end().ends_with("File");
                if traceback {
                    out.extend(&chars[i..=j]);
                } else {
                    out.push(c);
                    if j > i + 1 {
                        out.push('…');
                    }
                    out.push(c);
                }
                i = j + 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// The page is alive: `busy` while a job runs, `visible` unless the window is hidden.
#[tauri::command]
pub fn log_heartbeat(busy: bool, visible: bool) {
    let mut g = BEAT.lock().unwrap_or_else(|e| e.into_inner());
    let Some(b) = g.as_mut() else { return };
    let gap = b.at.elapsed().as_secs();
    let was = b.stalled;
    *b = Beat { at: Instant::now(), seen: true, busy, visible, stalled: false };
    drop(g);
    if was {
        info("watchdog", &format!("the page answers again after {gap} s"));
    }
}

/// A line from the page. `source` is a short tag ("ui", "job", "model").
#[tauri::command]
pub fn log_write(level: String, source: String, message: String) {
    let source: String = source.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(16).collect();
    let source = if source.is_empty() { "ui".to_string() } else { source };
    match level.as_str() {
        "error" => error(&source, &message),
        "warn" => warn(&source, &message),
        _ => info(&source, &message),
    }
}

#[tauri::command]
pub fn reveal_logs() -> crate::error::Result<()> {
    let p = path(&dir(), 0);
    if !p.exists() {
        info("app", "log folder opened");
    }
    tauri_plugin_opener::reveal_item_in_dir(&p).map_err(|e| crate::error::Error::msg(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::scrub;

    #[test]
    fn scrub_masks_quoted_values_and_keeps_tracebacks() {
        assert_eq!(scrub(r#"JSON Parse error: Unexpected identifier "Tremblay""#), r#"JSON Parse error: Unexpected identifier "…""#);
        assert_eq!(scrub("could not convert string to float: 'Jean Tremblay'"), "could not convert string to float: '…'");
        assert_eq!(scrub(r#"  File "/x/engine/pdf.py", line 12, in render"#), r#"  File "/x/engine/pdf.py", line 12, in render"#);
        assert_eq!(scrub("can't open l'adresse, it's fine"), "can't open l'adresse, it's fine");
        assert_eq!(scrub(r#"empty "" stays"#), r#"empty "" stays"#);
        assert_eq!(scrub(r#"unclosed "quote"#), r#"unclosed "quote"#);
    }
}
