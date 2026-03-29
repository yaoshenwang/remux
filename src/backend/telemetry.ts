import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type express from "express";

interface TelemetryInsertStatement {
  run(...args: unknown[]): void;
}

interface TelemetryDatabase {
  close?(): void;
  prepare(query: string): TelemetryInsertStatement;
  transaction<T>(callback: (rows: T[]) => void): (rows: T[]) => void;
}

type LoadTelemetryDatabase = () => Promise<TelemetryDatabase>;

const defaultLoadTelemetryDatabase = async (): Promise<TelemetryDatabase> => {
  const { openDb } = await import("@microsoft/snapfeed-server");
  const telemetryDir = path.join(os.homedir(), ".remux");
  fs.mkdirSync(telemetryDir, { recursive: true });
  return openDb({ path: path.join(telemetryDir, "feedback.db") });
};

const registerDisabledTelemetryRoute = (
  app: express.Express,
): void => {
  app.post("/api/telemetry/events", (_req, res) => {
    res.status(202).json({ ok: false, disabled: true });
  });
};

export const registerTelemetryRoutes = async (
  app: express.Express,
  logger: Pick<Console, "error">,
  loadTelemetryDatabase: LoadTelemetryDatabase = defaultLoadTelemetryDatabase,
): Promise<{ close(): void }> => {
  try {
    const db = await loadTelemetryDatabase();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO ui_telemetry
        (session_id, seq, ts, event_type, page, target, detail_json, screenshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMany = db.transaction((rows: Array<Record<string, unknown>>) => {
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

    app.post("/api/telemetry/events", (req, res) => {
      const body = req.body as { events?: Array<Record<string, unknown>> };
      const events = body?.events;
      if (!Array.isArray(events) || events.length === 0) {
        res.status(400).json({ error: "events array required" });
        return;
      }

      insertMany(events);
      res.json({ accepted: events.length });
    });

    return {
      close() {
        db.close?.();
      },
    };
  } catch (error) {
    logger.error("snapfeed init failed:", String(error));
    registerDisabledTelemetryRoute(app);
    return {
      close() {},
    };
  }
};
