"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { scoreModelResults, type BenchmarkCategory, type ModelScenarioResult, type ModelScoreSummary } from "@/lib/benchmark";
import type { PublicModelConfig } from "@/lib/models";
import type { RunEvent } from "@/lib/orchestrator";

import { OrchestratorDialog } from "@/components/orchestrator-dialog";

type ScenarioCard = {
  id: string;
  title: string;
  category: BenchmarkCategory;
  description: string;
  userMessage: string;
  successCase: string;
  failureCase: string;
};

type DashboardProps = {
  primaryModels: PublicModelConfig[];
  secondaryModels: PublicModelConfig[];
  scenarios: ScenarioCard[];
  configError?: string | null;
};

type CellState = {
  phase: "idle" | "running" | "done";
  result?: ModelScenarioResult;
};

type FailureDetails = {
  modelName: string;
  scenarioId: string;
  summary: string;
  rawLog: string;
};

type ScoreSummaryMap = Record<string, ModelScoreSummary>;

const QWEN_VARIANT_ORDER = ["0.8b", "2b", "4b", "9b", "27b", "35b", "122b", "397b"];

function buildInitialCells(models: PublicModelConfig[], scenarios: ScenarioCard[]): Record<string, Record<string, CellState>> {
  return Object.fromEntries(
    models.map((model) => [
      model.id,
      Object.fromEntries(scenarios.map((scenario) => [scenario.id, { phase: "idle" } satisfies CellState]))
    ])
  );
}

function formatProgress(status: "idle" | "running" | "done" | "error"): string {
  switch (status) {
    case "running":
      return "Running";
    case "done":
      return "Completed";
    case "error":
      return "Errored";
    default:
      return "Idle";
  }
}

function extractVariantLabel(modelName: string): string {
  const match = modelName.toLowerCase().match(/(\d+(?:\.\d+)?)b/);
  return match ? `${match[1]}b` : modelName;
}

function variantOrderIndex(modelName: string): number {
  const label = extractVariantLabel(modelName);
  const index = QWEN_VARIANT_ORDER.indexOf(label);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function buildScoreSummaries(
  cells: Record<string, Record<string, CellState>>,
  models: PublicModelConfig[],
  scenarios: ScenarioCard[]
): ScoreSummaryMap {
  return Object.fromEntries(
    models.flatMap((model) => {
      const results = scenarios
        .map((scenario) => cells[model.id]?.[scenario.id]?.result)
        .filter((result): result is ModelScenarioResult => Boolean(result));

      if (results.length !== scenarios.length) {
        return [];
      }

      return [[model.id, scoreModelResults(results)]];
    })
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4.5 10.2 8.2 14l7.3-8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2.2" />
    </svg>
  );
}

function TimerIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M7.5 2.75h5M10 5.25v4l2.4 1.5M6.25 2.75h7.5M10 17.25a6.25 6.25 0 1 0 0-12.5 6.25 6.25 0 0 0 0 12.5Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.9"
      />
    </svg>
  );
}

function isTimeoutSummary(summary: string | undefined): boolean {
  return summary?.toLowerCase().includes("timed out") ?? false;
}

function FailureDialog({ details, onClose }: { details: FailureDetails | null; onClose: () => void }) {
  if (!details) {
    return null;
  }

  const timedOut = isTimeoutSummary(details.summary);

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog-shell trace-dialog" role="dialog" aria-modal="true" aria-labelledby="trace-title">
        <div className="dialog-header">
          <div>
            <p className="eyebrow">Failure Trace</p>
            <h2 id="trace-title">
              {details.scenarioId} · {details.modelName}
            </h2>
          </div>
          <button className="ghost-button" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="dialog-summary">
          <div className={`status-chip ${timedOut ? "status-timeout" : "status-error"}`}>{timedOut ? "Timed out" : "Failed"}</div>
          <p>{details.summary}</p>
        </div>
        <pre className="trace-log">{details.rawLog}</pre>
      </div>
    </div>
  );
}

export function Dashboard({ primaryModels, secondaryModels, scenarios, configError }: DashboardProps) {
  const allModels = useMemo(() => [...primaryModels, ...secondaryModels], [primaryModels, secondaryModels]);
  const [cells, setCells] = useState(() => buildInitialCells(allModels, scenarios));
  const cellsRef = useRef(cells);
  const [scoreSummaries, setScoreSummaries] = useState<ScoreSummaryMap>({});
  const [runnerStatus, setRunnerStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [currentScenarioId, setCurrentScenarioId] = useState(scenarios[0]?.id ?? "");
  const [focusedScenarioId, setFocusedScenarioId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [logs, setLogs] = useState<Array<{ id: string; message: string }>>([]);
  const [failureDetails, setFailureDetails] = useState<FailureDetails | null>(null);
  const [afmConcurrency, setAfmConcurrency] = useState(1);
  const eventSourceRef = useRef<EventSource | null>(null);

  const displayPrimaryModels = useMemo(
    () => [...primaryModels].sort((left, right) => variantOrderIndex(left.model) - variantOrderIndex(right.model)),
    [primaryModels]
  );
  const displaySecondaryModels = useMemo(
    () => [...secondaryModels].sort((left, right) => variantOrderIndex(left.model) - variantOrderIndex(right.model)),
    [secondaryModels]
  );
  const displayAllModels = useMemo(
    () => [...displayPrimaryModels, ...displaySecondaryModels],
    [displayPrimaryModels, displaySecondaryModels]
  );
  const rankedScorecards = useMemo(
    () =>
      displayAllModels
        .flatMap((model) => {
          const summary = scoreSummaries[model.id];
          return summary ? [{ model, summary }] : [];
        })
        .sort((left, right) => {
          if (right.summary.finalScore !== left.summary.finalScore) {
            return right.summary.finalScore - left.summary.finalScore;
          }

          if (right.summary.totalPoints !== left.summary.totalPoints) {
            return right.summary.totalPoints - left.summary.totalPoints;
          }

          return variantOrderIndex(left.model.model) - variantOrderIndex(right.model.model);
        }),
    [displayAllModels, scoreSummaries]
  );
  const detailScenarioId = focusedScenarioId ?? currentScenarioId;
  const detailScenario = scenarios.find((scenario) => scenario.id === detailScenarioId) ?? scenarios[0];
  const currentScenario = scenarios.find((scenario) => scenario.id === currentScenarioId) ?? scenarios[0];
  const currentScenarioLabel = currentScenario ? `${currentScenario.id} ${currentScenario.title}` : "";

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  function appendLog(message: string) {
    setLogs((previous) => {
      const next = [...previous, { id: crypto.randomUUID(), message }];
      return next.slice(-80);
    });
  }

  function resetRunState() {
    const nextCells = buildInitialCells(allModels, scenarios);
    cellsRef.current = nextCells;
    setCells(nextCells);
    setScoreSummaries({});
    setLogs([]);
    setFailureDetails(null);
    setCurrentScenarioId(scenarios[0]?.id ?? "");
    setFocusedScenarioId(null);
  }

  function resetScenarioState(scenarioId: string) {
    setCells((previous) => {
      const next = Object.fromEntries(
        allModels.map((model) => [
          model.id,
          {
            ...(previous[model.id] ?? {}),
            [scenarioId]: { phase: "idle" } satisfies CellState
          }
        ])
      );
      cellsRef.current = next;
      return next;
    });
    setFailureDetails((previous) => (previous?.scenarioId === scenarioId ? null : previous));
    setCurrentScenarioId(scenarioId);
    setFocusedScenarioId(scenarioId);
  }

  function updateCell(modelId: string, scenarioId: string, updater: (previous: CellState) => CellState) {
    setCells((previous) => {
      const next = {
        ...previous,
        [modelId]: {
          ...previous[modelId],
          [scenarioId]: updater(previous[modelId]?.[scenarioId] ?? { phase: "idle" })
        }
      };
      cellsRef.current = next;
      return next;
    });
  }

  function renderScoreboard() {
    if (rankedScorecards.length === 0) {
      return null;
    }

    return (
      <section className="scoreboard">
        {rankedScorecards.map(({ model, summary }) => (
          <article key={model.id} className="score-card">
            <div>
              <div className="score-card-header">
                <div>
                  <p className="eyebrow">Result</p>
                  <h2>{model.model}</h2>
                </div>
              </div>
              <p className="score-rating">{summary.totalPoints}/{summary.maxPoints} points via {model.provider}</p>
            </div>
            <div>
              <strong className="score-value">{summary.finalScore}%</strong>
              <div className="category-strip">
                {summary.categoryScores.map((categoryScore) => (
                  <span key={categoryScore.category} className="category-pill">
                    <strong>{categoryScore.category}</strong>
                    <span>
                      {categoryScore.earned}/{categoryScore.max}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          </article>
        ))}
      </section>
    );
  }

  function handleEvent(event: RunEvent) {
    switch (event.type) {
      case "run_started":
        setRunnerStatus("running");
        appendLog(`Run started for ${event.models.length} model(s).`);
        break;
      case "scenario_started":
        setCurrentScenarioId(event.scenarioId);
        appendLog(`Starting ${event.scenarioId} ${event.title}.`);
        break;
      case "model_progress":
        updateCell(event.modelId, event.scenarioId, (previous) => ({
          ...previous,
          phase: "running"
        }));
        appendLog(`${event.modelId} · ${event.scenarioId}: ${event.message}`);
        break;
      case "scenario_result":
        updateCell(event.modelId, event.scenarioId, () => ({
          phase: "done",
          result: event.result
        }));
        appendLog(`${event.modelId} · ${event.scenarioId}: ${event.result.status.toUpperCase()} (${event.result.summary})`);
        break;
      case "scenario_finished":
        appendLog(`Completed ${event.scenarioId} across all variants.`);
        break;
      case "run_finished":
        setRunnerStatus("done");
        setScoreSummaries(event.scores);
        appendLog("Benchmark completed.");
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
        break;
      case "run_error":
        setRunnerStatus("error");
        appendLog(`Error: ${event.message}`);
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
        break;
    }
  }

  function startRunWithSource(targetScenarioId?: string, batch?: boolean) {
    eventSourceRef.current?.close();
    if (targetScenarioId) {
      resetScenarioState(targetScenarioId);
      appendLog(`Retrying ${targetScenarioId} across all variants.`);
    } else {
      resetRunState();
    }
    setRunnerStatus("running");

    const params = new URLSearchParams({
      models: displayAllModels.map((model) => model.id).join(",")
    });

    if (targetScenarioId) {
      params.set("scenarios", targetScenarioId);
    }

    if (afmConcurrency > 1) {
      params.set("concurrency", String(afmConcurrency));
    }

    if (batch) {
      params.set("batch", "true");
    }

    const source = new EventSource(`/api/run?${params.toString()}`);
    eventSourceRef.current = source;

    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as RunEvent;
      handleEvent(event);
    };

    source.onerror = () => {
      if (eventSourceRef.current) {
        setRunnerStatus("error");
        appendLog("Event stream disconnected.");
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }

  function renderCell(model: PublicModelConfig, scenario: ScenarioCard) {
    const cell = cells[model.id]?.[scenario.id];

    if (cell?.phase === "running") {
      return (
        <div className="result-icon-shell result-loading" aria-label={`${scenario.id} loading`}>
          <span className="spinner" />
        </div>
      );
    }

    if (cell?.result) {
      const isPass = cell.result.status === "pass";
      const isTimeout = !isPass && isTimeoutSummary(cell.result.summary);

      return (
        <button
          className={`result-icon-button ${isPass ? "result-pass" : isTimeout ? "result-timeout" : "result-fail"}`}
          type="button"
          aria-label={`${scenario.id} ${isPass ? "completed" : isTimeout ? "timed out" : "failed"} for ${extractVariantLabel(model.model)}. Show trace.`}
          onClick={() =>
            setFailureDetails({
              modelName: extractVariantLabel(model.model),
              scenarioId: scenario.id,
              summary: cell.result?.summary ?? "Scenario failed.",
              rawLog: cell.result?.rawLog ?? "No raw log available."
            })
          }
        >
          {isPass ? <CheckIcon /> : isTimeout ? <TimerIcon /> : <CrossIcon />}
        </button>
      );
    }

    return <div className="result-icon-shell result-idle" aria-hidden="true" />;
  }

  function renderModelTable(title: string, models: PublicModelConfig[]) {
    return (
      <section className="table-card">
        <div className="table-scroll">
          <table className="result-table minimalist-table">
            <thead>
              <tr>
                <th>Model</th>
                {scenarios.map((scenario) => (
                  <th
                    key={scenario.id}
                    className={`${scenario.id === currentScenarioId ? "active-column" : ""} ${scenario.id === detailScenarioId ? "selected-column" : ""}`.trim()}
                  >
                    <div className="column-heading">
                      <button
                        className="column-button"
                        type="button"
                        onClick={(event) => {
                          if (event.shiftKey) {
                            startRunWithSource(scenario.id);
                            return;
                          }

                          setFocusedScenarioId(scenario.id);
                        }}
                        title="Shift+Click to retry this scenario"
                      >
                        {scenario.id}
                      </button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {models.length > 0 ? (
                models.map((model) => (
                  <tr key={model.id}>
                    <td className="scenario-row-label">
                      <span className="model-badge">{extractVariantLabel(model.model)}</span>
                    </td>
                    {scenarios.map((scenario) => (
                      <td
                        key={`${model.id}-${scenario.id}`}
                        className={`result-icon-cell ${scenario.id === currentScenarioId ? "active-column" : ""}`.trim()}
                      >
                        {renderCell(model, scenario)}
                      </td>
                    ))}
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="empty-table-row" colSpan={scenarios.length + 1}>
                    No models configured in {title}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="hero-panel">
        <div>
          <h1>ToolCall-15 LLM Tool Use Benchmark</h1>
          {configError ? <p className="config-error">{configError}</p> : null}
        </div>
        <div className="hero-actions">
          <label className="concurrency-control">
            <span>Parallel</span>
            <select
              value={afmConcurrency}
              onChange={(e) => setAfmConcurrency(Number(e.target.value))}
              disabled={runnerStatus === "running"}
            >
              {[1, 2, 3, 4, 5, 6, 8, 10, 15].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <button
            className="primary-button"
            type="button"
            onClick={() => startRunWithSource()}
            disabled={allModels.length === 0 || runnerStatus === "running"}
          >
            {runnerStatus === "running" ? "Benchmark Running" : "Run Benchmark"}
          </button>
          <button
            className="ghost-button batch-button"
            type="button"
            onClick={() => startRunWithSource(undefined, true)}
            disabled={allModels.length === 0 || runnerStatus === "running"}
          >
            Batch Test
          </button>
        </div>
      </section>

      <section className="scenario-focus">
        <div className="scenario-focus-header">
          <div>
            <p className="eyebrow">{focusedScenarioId ? "Viewing Scenario" : runnerStatus === "running" ? "Current Scenario" : "Scenario Preview"}</p>
            <h2>
              {detailScenario?.id} · {detailScenario?.title}
            </h2>
          </div>
          <div className={`status-chip status-${runnerStatus}`}>{runnerStatus === "running" ? "Live" : formatProgress(runnerStatus)}</div>
        </div>
        <p className="scenario-prompt">{detailScenario?.userMessage}</p>
        <div className="scenario-detail-grid">
          <article className="scenario-detail-card">
            <h3>What this tests</h3>
            <p>{detailScenario?.description}</p>
          </article>
          <article className="scenario-detail-card">
            <h3>Success case</h3>
            <p>{detailScenario?.successCase}</p>
          </article>
          <article className="scenario-detail-card">
            <h3>Failure case</h3>
            <p>{detailScenario?.failureCase}</p>
          </article>
        </div>
      </section>

      {renderScoreboard()}

      {renderModelTable("LLM_MODELS", displayPrimaryModels)}
      {secondaryModels.length > 0 ? renderModelTable("LLM_MODELS_2", displaySecondaryModels) : null}

      <OrchestratorDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        currentScenarioLabel={currentScenarioLabel}
        status={runnerStatus}
        logs={logs}
      />

      <FailureDialog details={failureDetails} onClose={() => setFailureDetails(null)} />
    </>
  );
}
