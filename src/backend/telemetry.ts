import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type express from "express";

interface TelemetryInsertStatement {
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): void;
}

interface TelemetryDatabase {
  close?(): void;
  prepare(query: string): TelemetryInsertStatement;
  transaction<T>(callback: (rows: T) => void): (rows: T) => void;
}

type LoadTelemetryDatabase = () => Promise<TelemetryDatabase>;

const defaultLoadTelemetryDatabase = async (): Promise<TelemetryDatabase> => {
  const { openDb } = await import("@microsoft/snapfeed-server");
  const telemetryDir = path.join(os.homedir(), ".remux");
  fs.mkdirSync(telemetryDir, { recursive: true });
  return openDb({ path: path.join(telemetryDir, "feedback.db") });
};

export const registerTelemetryRoutes = async (
  app: express.Express,
  requireApiAuth: express.RequestHandler,
  logger: Pick<Console, "error">,
  loadTelemetryDatabase: LoadTelemetryDatabase = defaultLoadTelemetryDatabase,
): Promise<{ close(): void }> => {
  let telemetryDb: TelemetryDatabase | null = null;

  try {
    telemetryDb = await loadTelemetryDatabase();
  } catch (error) {
    logger.error("snapfeed init failed:", String(error));
  }

  app.post("/api/telemetry/events", (req, res) => {
    if (!telemetryDb) {
      res.status(202).json({ ok: false, disabled: true });
      return;
    }

    const body = req.body as { events?: Array<Record<string, unknown>> };
    const events = body?.events;
    if (!Array.isArray(events) || events.length === 0) {
      res.status(400).json({ error: "events array required" });
      return;
    }

    const insert = telemetryDb.prepare(
      `INSERT OR IGNORE INTO ui_telemetry
        (session_id, seq, ts, event_type, page, target, detail_json, screenshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMany = telemetryDb.transaction((rows: Array<Record<string, unknown>>) => {
      for (const event of rows) {
        insert.run(
          event.session_id,
          event.seq,
          event.ts,
          event.event_type,
          event.page ?? null,
          event.target ?? null,
          event.detail ? JSON.stringify(event.detail) : null,
          event.screenshot ?? null,
        );
      }
    });
    insertMany(events);
    res.json({ accepted: events.length });
  });

  app.get("/api/telemetry/events", requireApiAuth, (req, res) => {
    if (!telemetryDb) {
      res.status(503).json({ error: "telemetry unavailable" });
      return;
    }

    const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : undefined;
    const eventType = typeof req.query.event_type === "string" ? req.query.event_type : undefined;
    const requestedLimit = Number(req.query.limit ?? 200);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 1000) : 200;

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (sessionId) {
      clauses.push("session_id = ?");
      params.push(sessionId);
    }
    if (eventType) {
      clauses.push("event_type = ?");
      params.push(eventType);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);

    const rows = telemetryDb.prepare(
      `SELECT id, session_id, seq, ts, event_type, page, target, detail_json
       FROM ui_telemetry ${where} ORDER BY id DESC LIMIT ?`,
    ).all(...params);

    res.json(rows);
  });

  app.get("/api/telemetry/sessions", requireApiAuth, (req, res) => {
    if (!telemetryDb) {
      res.status(503).json({ error: "telemetry unavailable" });
      return;
    }

    const requestedLimit = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100) : 20;
    const rows = telemetryDb.prepare(
      `SELECT session_id,
              MIN(ts) as first_event,
              MAX(ts) as last_event,
              COUNT(*) as event_count,
              SUM(CASE WHEN event_type = 'error' THEN 1 ELSE 0 END) as error_count
       FROM ui_telemetry
       GROUP BY session_id
       ORDER BY MAX(created_at) DESC
       LIMIT ?`,
    ).all(limit);

    res.json(rows);
  });

  app.get("/api/telemetry/events/:id/screenshot", requireApiAuth, (req, res) => {
    if (!telemetryDb) {
      res.status(503).json({ error: "telemetry unavailable" });
      return;
    }

    const eventId = Number(req.params.id);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      res.status(400).json({ error: "invalid event id" });
      return;
    }

    const row = telemetryDb.prepare(
      "SELECT screenshot FROM ui_telemetry WHERE id = ?",
    ).get(eventId) as { screenshot: string | null } | undefined;

    if (!row?.screenshot) {
      res.status(404).json({ error: "No screenshot for this event" });
      return;
    }

    res.type("image/jpeg").send(Buffer.from(row.screenshot, "base64"));
  });

  return {
    close() {
      telemetryDb?.close?.();
    },
  };
};
