import { useEffect, useState } from "react";
import type { Detector } from "../api";
import { t } from "../i18n";
import { native, errorCode, type ModelInfo, type SystemInfo } from "./native";
import {
  cancelDownload,
  formatBytes,
  startDownload,
  useDownloads,
} from "./models";
import { modelCatalog } from "./platform";
import { Icon } from "../components/icons";
import { ErrorNotice, Spinner } from "../components/ui";

/**
 * How documents are read: fast detection (the small model in the engine and
 * the rules, always on), plus an optional deep check by a bigger model, one
 * of the Gemma 4 sizes (downloaded once). Nothing suggests the deep check:
 * onboarding shows fast detection only, and Settings keeps it folded until
 * the user opens it. Shared by onboarding and Settings.
 */
export function ModelPicker({
  detector,
  onChange,
  compact,
}: {
  detector: Detector;
  onChange: (d: Detector) => Promise<void> | void;
  /** Onboarding: fast detection only; the deep check is for Settings. */
  compact?: boolean;
}) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const downloads = useDownloads();

  const refresh = async () => setModels(await modelCatalog(true));
  useEffect(() => {
    void refresh();
    void native.systemInfo().then(setSys);
  }, []);
  // A finished download changes what's installed.
  const doneCount = [...downloads.values()].filter((d) => !d.running).length;
  useEffect(() => void refresh(), [doneCount]);

  if (!models || !sys) return <Spinner />;
  const fast = (
    <div
      className={`dv-core model wide${detector.engine === "none" ? " selected" : ""}`}
    >
      <div>
        <div className="model-head">
          <span className="model-name">{t("model.fast")}</span>
          <span className="dv-badge accent">{t("model.recommended")}</span>
          {detector.engine === "none" && (
            <span className="dv-badge ok live">{t("model.inUse")}</span>
          )}
        </div>
        <div className="model-meta">
          <span>{t("model.fastHint")}</span>
        </div>
      </div>
      <div className="model-actions">
        {detector.engine !== "none" && (
          <button
            className="dv-button primary small"
            onClick={() => void use({ engine: "none" })}
          >
            {t("model.use")}
          </button>
        )}
      </div>
    </div>
  );
  async function use(d: Detector) {
    setError(null);
    try {
      await onChange(d);
    } catch (e) {
      setError(e);
    }
  }

  const deep = models.map((m) => {
    const dl = downloads.get(m.id);
    const selected = detector.engine === "builtin" && detector.model === m.id;
    const tooBig = m.minRamGb > sys.ramGb;
    const total = dl?.progress?.total || m.totalSize || 1;
    const received = dl?.progress?.received ?? 0;
    return (
      <div key={m.id} className={`dv-core model${selected ? " selected" : ""}`}>
        <div>
          <div className="model-head">
            <span className="model-name">{t(`model.tier.${m.tier}`)}</span>
            <span className="model-tech">{m.name}</span>
            {selected && (
              <span className="dv-badge ok live">{t("model.inUse")}</span>
            )}
          </div>
          <div className="model-meta">
            <span className="dv-num">
              <Icon name="hardDrives" />
              {m.available ? formatBytes(m.totalSize) : t("model.soon")}
            </span>
            <span>
              <Icon name="memory" />
              {t("model.minRam", { n: m.minRamGb })}
            </span>
            {tooBig && (
              <span className="slow">
                <Icon name="warning" />
                {t("model.tooBig")}
              </span>
            )}
          </div>
        </div>
        <div className="model-actions">
          {m.installed && !selected && (
            <button
              className="dv-button primary small"
              onClick={() => void use({ engine: "builtin", model: m.id })}
            >
              {t("model.use")}
            </button>
          )}
          {m.installed && !m.complete && m.available && !dl?.running && (
            // Imported without its draft: works, at half speed.
            <button
              className="dv-button ghost small"
              title={t("model.speedupHint")}
              onClick={() => void startDownload(m.id)}
            >
              <Icon name="download" />
              {t("model.speedup", { n: formatBytes(m.totalSize - m.size) })}
            </button>
          )}
          {!m.installed && m.available && !dl?.running && (
            <>
              <button
                className={selected ? "dv-button primary small" : "dv-button small"}
                onClick={() => {
                  void startDownload(m.id);
                  if (!selected) void use({ engine: "builtin", model: m.id });
                }}
              >
                <Icon name="download" />
                {m.partialBytes > 0 ? t("model.resume") : t("model.download")}
              </button>
              <button
                className="dv-button ghost small"
                onClick={async () => {
                  try {
                    if (await native.modelImport(m.id)) {
                      await refresh();
                      await use({ engine: "builtin", model: m.id });
                    }
                  } catch (e) {
                    setError(
                      new Error(
                        errorCode(e) === "import_mismatch"
                          ? t("model.importMismatch")
                          : errorCode(e),
                      ),
                    );
                  }
                }}
              >
                {t("model.import")}
              </button>
            </>
          )}
          {dl?.running && (
            <button className="dv-button small" onClick={() => void cancelDownload(m.id)}>
              <Icon name="pause" />
              {t("model.pause")}
            </button>
          )}
          {m.installed && (
            <button
              className="dv-button ghost danger small"
              onClick={async () => {
                await native.modelDelete(m.id);
                if (selected) await use({ engine: "none" });
                await refresh();
              }}
            >
              {t("remove")}
            </button>
          )}
        </div>
        {dl?.running && (
          <div className="model-extra">
            <div
              className="meter"
              role="progressbar"
              aria-label={m.name}
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={received}
            >
              <span
                style={{ width: `${Math.min(100, (received / total) * 100)}%` }}
              />
            </div>
            <div className="meter-text">
              <span>
                {dl.progress?.phase === "verifying"
                  ? t("model.verifying")
                  : t("model.progress", {
                      got: formatBytes(received),
                      total: formatBytes(total),
                      speed: formatBytes(dl.progress?.bytesPerSec ?? 0),
                    })}
              </span>
              <span>{Math.floor((received / total) * 100)} %</span>
            </div>
          </div>
        )}
        {dl?.error && (
          <div className="model-extra">
            <div className="dv-notice error">
              <Icon name="warningCircle" />
              <span>{t("model.downloadFailed", { e: dl.error })}</span>
            </div>
          </div>
        )}
      </div>
    );
  });

  return (
    <div className="model-picker">
      <div className={`models dv-shell${compact ? " compact" : ""}`}>
        {fast}
        {!compact && (
          <details
            className="model-more"
            open={
              detector.engine !== "none" ||
              [...downloads.values()].some((d) => d.running)
            }
          >
            <summary className="dv-core">
              <span>{t("model.deep")}</span>
              <Icon name="caretDown" />
            </summary>
            <p className="ram-note">
              <Icon name="memory" />
              {t("model.deepHint")} {t("model.ram", { n: sys.ramGb })}
            </p>
            <div className="models">{deep}</div>
          </details>
        )}
      </div>
      <ErrorNotice error={error} />
    </div>
  );
}
