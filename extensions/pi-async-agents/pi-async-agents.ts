import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const EVENT_LAUNCH = "pi-async-agents:fork";
const EVENT_UPDATE = "pi-async-agents:update";
const EVENT_CAPABILITIES_REQUEST = "pi-async-agents:capabilities:request";

const DEFAULT_TOOLS = "read,grep,find,ls";
const SYSTEM_APPEND = `You are running as a background async subagent for the main Pi session.

Your job is to complete the delegated task independently and produce a concise final report for the main agent.

Rules:
- Work autonomously. Do not ask the user questions unless the task is impossible without missing information.
- Prefer investigation, implementation, verification, and concise reporting.
- If you change files, clearly summarize the files changed and the reason.
- If you cannot proceed safely or need human input, end your final response with:
  NEEDS_INPUT: <specific question or blocker>
- Otherwise, end your final response with:
  ASYNC_AGENT_DONE

Your final assistant message will be sent back to the main Pi conversation as a user follow-up message.
Make that final message useful to the main agent: include the outcome, key findings, changed files, commands run, and remaining risks.`;

type JobStatus = "queued" | "running" | "done" | "failed" | "needs_input" | "canceled";

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface AsyncJob {
  id: string;
  name: string;
  task: string;
  status: JobStatus;
  cwd: string;
  parentSessionFile?: string;
  sessionId: string;
  sessionFile?: string;
  startedAt: number;
  endedAt?: number;
  finalText?: string;
  errorText?: string;
  lastActions: string[];
  usage: Usage;
  process?: ChildProcessWithoutNullStreams;
  stdoutBuffer: string;
  pending: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>;
  requestSeq: number;
  postedResult: boolean;
}

interface ForkRequest {
  task: string;
  name?: string;
  model?: string;
  tools?: string;
  cwd?: string;
  sendResultToMain?: boolean;
}

interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

function makeId(): string {
  return `async-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeSessionId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || `async-${Date.now().toString(36)}`;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function formatTokens(n: number): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function inferName(task: string): string {
  const first = task.trim().split(/\s+/).slice(0, 3).join(" ");
  return first || "agent";
}

function buildSystemAppend(job: AsyncJob): string {
  return `${SYSTEM_APPEND}

Async agent metadata:
- Agent name: ${job.name}
- Job id: ${job.id}
- Parent cwd: ${job.cwd}
- Delegated task: ${job.task}`;
}

function buildPrompt(job: AsyncJob): string {
  return job.task;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: "pi", args };
}

function textFromMessage(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  const parts = message.content ?? [];
  return parts
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text ?? "")
    .join("\n")
    .trim();
}

function updateUsage(job: AsyncJob, message: any): void {
  if (message?.role !== "assistant") return;
  job.usage.turns++;
  const usage = message.usage;
  if (!usage) return;
  job.usage.input += usage.input || 0;
  job.usage.output += usage.output || 0;
  job.usage.cacheRead += usage.cacheRead || 0;
  job.usage.cacheWrite += usage.cacheWrite || 0;
  job.usage.cost += usage.cost?.total || 0;
  job.usage.contextTokens = usage.totalTokens || job.usage.contextTokens;
}

function classifyFinal(text: string): JobStatus {
  return /NEEDS_INPUT:/i.test(text) ? "needs_input" : "done";
}

function finalForMain(job: AsyncJob): string {
  const markerStripped = (job.finalText ?? "")
    .replace(/\n?ASYNC_AGENT_DONE\s*$/i, "")
    .trim();
  return [`Async agent '${job.name}' finished.`, "", markerStripped || "(no final output)"].join("\n");
}

function circle(status: JobStatus, theme: Theme): string {
  const color = status === "failed" ? "error" : status === "needs_input" ? "warning" : status === "canceled" ? "dim" : status === "done" ? "accent" : "muted";
  return theme.fg(color, "○");
}

function renderJobLine(job: AsyncJob, theme: Theme, width: number): string {
  const elapsed = formatDuration((job.endedAt ?? Date.now()) - job.startedAt);
  const usage = `↑${formatTokens(job.usage.input)} ↓${formatTokens(job.usage.output)} $${job.usage.cost.toFixed(4)}`;
  const raw = `${job.name} ${job.status} ${elapsed} ${usage} ${job.task}`;
  return truncateToWidth(`${circle(job.status, theme)} ${raw}`, width);
}

function renderWidget(jobs: AsyncJob[], theme: Theme, width: number): string[] {
  const visible = jobs.slice(-3);
  return visible.map((job) => renderJobLine(job, theme, width));
}

function emitUpdate(pi: ExtensionAPI, job: AsyncJob): void {
  pi.events.emit(EVENT_UPDATE, snapshotJob(job));
}

function snapshotJob(job: AsyncJob) {
  return {
    id: job.id,
    name: job.name,
    task: job.task,
    status: job.status,
    cwd: job.cwd,
    parentSessionFile: job.parentSessionFile,
    sessionId: job.sessionId,
    sessionFile: job.sessionFile,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    finalText: job.finalText,
    errorText: job.errorText,
    lastActions: [...job.lastActions],
    usage: { ...job.usage },
  };
}

export default function asyncAgents(pi: ExtensionAPI) {
  const jobs = new Map<string, AsyncJob>();
  let activeCtx: ExtensionContext | undefined;

  function updateWidget() {
    const ctx = activeCtx;
    if (!ctx?.hasUI || ctx.mode !== "tui") return;
    const visibleJobs = [...jobs.values()].filter((job) => job.status !== "canceled");
    if (visibleJobs.length === 0) {
      ctx.ui.setWidget("pi-async-agents", undefined);
      return;
    }
    ctx.ui.setWidget("pi-async-agents", (_tui: any, theme: Theme) => ({
      render: (width: number) => renderWidget(visibleJobs, theme, width),
      invalidate() {},
      dispose() {},
    }), { placement: "belowEditor" });
  }

  function sendRpc(job: AsyncJob, type: string, payload: Record<string, any> = {}): Promise<any> {
    if (!job.process || job.process.killed) return Promise.reject(new Error("Async agent process is not running"));
    const id = `${job.id}-${++job.requestSeq}`;
    const message = { id, type, ...payload };
    return new Promise((resolve, reject) => {
      job.pending.set(id, { resolve, reject });
      job.process!.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  async function postResultToMain(job: AsyncJob) {
    if (job.postedResult || job.status === "canceled" || job.status === "failed") return;
    job.postedResult = true;
    try {
      await (pi.sendUserMessage as any)(finalForMain(job), { deliverAs: "followUp" });
    } catch {
      /* ignore */
    }
  }

  function handleRpcEvent(job: AsyncJob, event: any) {
    if (event.type === "response") {
      const pending = event.id ? job.pending.get(event.id) : undefined;
      if (pending) {
        job.pending.delete(event.id);
        if (event.success === false) pending.reject(new Error(event.error || `RPC ${event.command ?? "command"} failed`));
        else pending.resolve(event.data);
      }
      return;
    }

    if (event.type === "message_end" && event.message) {
      const text = textFromMessage(event.message);
      if (text) {
        job.finalText = text;
        job.lastActions.push(text.split("\n")[0].slice(0, 160));
        job.lastActions = job.lastActions.slice(-8);
      }
      updateUsage(job, event.message);
    } else if (event.type === "tool_execution_start") {
      const label = event.toolName ? `${event.toolName} ${JSON.stringify(event.args ?? {}).slice(0, 120)}` : "tool";
      job.lastActions.push(label);
      job.lastActions = job.lastActions.slice(-8);
    } else if (event.type === "agent_start") {
      job.status = "running";
    } else if (event.type === "agent_end") {
      job.endedAt = Date.now();
      job.status = classifyFinal(job.finalText ?? "");
      void postResultToMain(job);
    }

    emitUpdate(pi, job);
    updateWidget();
  }

  function handleRpcLine(job: AsyncJob, line: string) {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    handleRpcEvent(job, event);
  }

  async function launch(request: ForkRequest, ctx: ExtensionContext): Promise<AsyncJob> {
    const parentSessionFile = ctx.sessionManager.getSessionFile();
    const id = makeId();
    const job: AsyncJob = {
      id,
      name: request.name ?? inferName(request.task),
      task: request.task,
      status: "queued",
      cwd: request.cwd ?? ctx.cwd,
      parentSessionFile,
      sessionId: sanitizeSessionId(id),
      startedAt: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      lastActions: [],
      stdoutBuffer: "",
      pending: new Map(),
      requestSeq: 0,
      postedResult: false,
    };
    jobs.set(job.id, job);
    emitUpdate(pi, job);
    updateWidget();

    const args = ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--tools", request.tools ?? DEFAULT_TOOLS, "--append-system-prompt", buildSystemAppend(job), "--session-id", job.sessionId, "--name", job.name, "--approve"];
    if (request.model) args.push("--model", request.model);
    if (parentSessionFile) args.push("--fork", parentSessionFile);

    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: job.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_ASYNC_AGENT: "1", PI_ASYNC_AGENT_ID: job.id },
    });
    job.process = proc;

    proc.stdout.on("data", (chunk) => {
      job.stdoutBuffer += chunk.toString();
      const lines = job.stdoutBuffer.split("\n");
      job.stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) handleRpcLine(job, line);
    });
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) job.errorText = [job.errorText, text].filter(Boolean).join("\n");
    });
    proc.on("close", (code) => {
      if (job.stdoutBuffer.trim()) handleRpcLine(job, job.stdoutBuffer);
      for (const pending of job.pending.values()) pending.reject(new Error("Async agent exited"));
      job.pending.clear();
      if ((job.status === "queued" || job.status === "running") && code !== 0) {
        job.status = "failed";
        job.endedAt = Date.now();
        job.errorText = job.errorText || `Process exited with code ${code ?? "unknown"}`;
      }
      emitUpdate(pi, job);
      updateWidget();
    });

    try {
      const state = await sendRpc(job, "get_state");
      job.sessionFile = state?.sessionFile;
    } catch {
      /* ignore */
    }
    await sendRpc(job, "prompt", { message: buildPrompt(job) });
    return job;
  }

  async function stopJob(job: AsyncJob) {
    job.status = "canceled";
    job.endedAt = Date.now();
    try { await sendRpc(job, "abort"); } catch {}
    job.process?.kill("SIGTERM");
    emitUpdate(pi, job);
    updateWidget();
  }

  async function steerJob(job: AsyncJob, message: string) {
    if (job.status !== "running") return;
    await sendRpc(job, "steer", { message });
    job.lastActions.push(`steer: ${message.slice(0, 120)}`);
    job.lastActions = job.lastActions.slice(-8);
    emitUpdate(pi, job);
    updateWidget();
  }

  function showPanel(ctx: ExtensionContext) {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const list = () => [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
    if (list().length === 0) {
      ctx.ui.notify("No async agents", "info");
      return;
    }

    void ctx.ui.custom<void>((tui, theme: Theme, _kb, done) => {
      let selected = 0;
      let expanded = true;
      const render = (width: number) => {
        const current = list();
        selected = Math.max(0, Math.min(selected, current.length - 1));
        const lines: string[] = [theme.fg("accent", theme.bold("Async agents")), ""];
        current.forEach((job, index) => {
          const prefix = index === selected ? theme.fg("accent", "› ") : "  ";
          lines.push(prefix + renderJobLine(job, theme, Math.max(1, width - 2)));
        });
        const job = current[selected];
        if (job && expanded) {
          lines.push("", theme.fg("dim", "Last actions"));
          for (const action of job.lastActions.slice(-6)) lines.push(truncateToWidth(`  ${action}`, width));
          if (job.finalText) {
            lines.push("", theme.fg("dim", "Final"));
            for (const line of job.finalText.split("\n").slice(0, 8)) lines.push(truncateToWidth(`  ${line}`, width));
          }
          if (job.errorText) {
            lines.push("", theme.fg("error", "Error"));
            for (const line of job.errorText.split("\n").slice(-4)) lines.push(truncateToWidth(`  ${line}`, width));
          }
        }
        lines.push("", theme.fg("dim", "↑/↓ select · enter expand · s steer · x stop · d delete · esc close"));
        return lines.map((line) => truncateToWidth(line, width));
      };
      return {
        render,
        invalidate() {},
        handleInput(data: string) {
          const current = list();
          if (matchesKey(data, "escape")) return done(undefined);
          if (matchesKey(data, "up")) selected = Math.max(0, selected - 1);
          else if (matchesKey(data, "down")) selected = Math.min(current.length - 1, selected + 1);
          else if (matchesKey(data, "enter")) expanded = !expanded;
          else if (data === "d") {
            const job = current[selected];
            if (job) { jobs.delete(job.id); void stopJob(job); }
          } else if (data === "x") {
            const job = current[selected];
            if (job) void stopJob(job);
          } else if (data === "s") {
            const job = current[selected];
            if (job) {
              void ctx.ui.input("Steer async agent", "message...").then((msg) => {
                if (msg?.trim()) void steerJob(job, msg.trim());
              });
            }
          }
          tui.requestRender();
        },
      };
    }, { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" } });
  }

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return { action: "continue" };
    const match = event.text.match(/^\/fork\s+([\s\S]+)$/);
    if (!match) return { action: "continue" };
    const task = match[1]!.trim();
    if (!task) return { action: "continue" };
    await launch({ task }, ctx);
    return { action: "handled" };
  });

  pi.events.on(EVENT_LAUNCH, (data) => {
    if (!activeCtx) return;
    const req = data as ForkRequest;
    if (!req?.task?.trim()) return;
    void launch(req, activeCtx);
  });

  pi.events.on(EVENT_CAPABILITIES_REQUEST, (data) => {
    const req = data as { requestId?: string; replyTo?: string };
    if (!req?.replyTo) return;
    pi.events.emit(req.replyTo, {
      requestId: req.requestId,
      capabilities: ["fork", "status", "steer", "stop", "delete", "panel"],
      events: { fork: EVENT_LAUNCH, update: EVENT_UPDATE },
    });
  });

  pi.events.on("pi-async-agents:panel:open", () => {
    if (activeCtx) showPanel(activeCtx);
  });

  pi.on("session_start", (_event, ctx) => {
    activeCtx = ctx;
    updateWidget();
  });

  pi.on("session_shutdown", async () => {
    for (const job of jobs.values()) {
      if (job.status === "running" || job.status === "queued") job.process?.kill("SIGTERM");
    }
    activeCtx = undefined;
  });
}
