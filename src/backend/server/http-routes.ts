import fs from "node:fs";
import path from "node:path";
import express, { type RequestHandler } from "express";
import type { RuntimeConfig } from "../config.js";
import type { AuthService } from "../auth/auth-service.js";
import type { ServerDependencies } from "../server.js";

const getSingleParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value.join("/") : (value ?? "");

const sanitizeFilename = (raw: string): string => {
  let name = raw.replace(/[\\/\0]/g, "").replace(/\.\./g, "");
  name = name.trim();
  if (!name) {
    name = "upload";
  }
  return name;
};

interface RegisterHttpRoutesOptions {
  app: express.Express;
  authService: AuthService;
  config: RuntimeConfig;
  deps: ServerDependencies;
  frontendFallbackRoute: string;
  handleSwitchBackend: RequestHandler;
  isWebSocketPath: (requestPath: string) => boolean;
  logger: Pick<Console, "log" | "error">;
  readAuthHeaders: (req: express.Request) => { token?: string; password?: string };
  requireApiAuth: RequestHandler;
  runtimeMetadata: {
    version: string;
    gitBranch?: string;
    gitCommitSha?: string;
    gitDirty?: boolean;
  };
  uploadMaxBytes: number;
}

export const registerHttpRoutes = ({
  app,
  authService,
  config,
  deps,
  frontendFallbackRoute,
  handleSwitchBackend,
  isWebSocketPath,
  logger,
  readAuthHeaders,
  requireApiAuth,
  runtimeMetadata,
  uploadMaxBytes,
}: RegisterHttpRoutesOptions): void => {
  app.get("/api/config", (_req, res) => {
    res.json({
      version: runtimeMetadata.version,
      gitBranch: runtimeMetadata.gitBranch,
      gitCommitSha: runtimeMetadata.gitCommitSha,
      gitDirty: runtimeMetadata.gitDirty,
      passwordRequired: authService.requiresPassword(),
      scrollbackLines: config.scrollbackLines,
      pollIntervalMs: config.pollIntervalMs,
      uploadMaxSize: uploadMaxBytes,
      backendKind: deps.backend.kind
    });
  });

  app.post("/api/switch-backend", handleSwitchBackend);

  app.post(
    "/api/upload",
    express.raw({ limit: uploadMaxBytes, type: "application/octet-stream" }),
    async (req, res) => {
      const authResult = authService.verify(readAuthHeaders(req));
      if (!authResult.ok) {
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
      }

      const rawFilename = req.headers["x-filename"] as string | undefined;
      if (!rawFilename) {
        res.status(400).json({ ok: false, error: "missing X-Filename header" });
        return;
      }

      const filename = sanitizeFilename(rawFilename);
      const paneCwd = req.headers["x-pane-cwd"] as string | undefined;
      const uploadDir = paneCwd || process.cwd();

      try {
        const dirStat = await fs.promises.stat(uploadDir);
        if (!dirStat.isDirectory()) {
          res.status(400).json({ ok: false, error: "upload directory is not a directory" });
          return;
        }
      } catch {
        // Fall back to cwd if the pane CWD doesn't exist.
      }

      const resolvedDir = await fs.promises.stat(uploadDir).then(
        (stat) => (stat.isDirectory() ? uploadDir : process.cwd()),
        () => process.cwd()
      );

      const body = req.body as Buffer;
      let finalName = filename;
      let finalPath = path.join(resolvedDir, finalName);
      try {
        await fs.promises.writeFile(finalPath, body, { flag: "wx" });
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          finalName = `upload-${Date.now()}-${filename}`;
          finalPath = path.join(resolvedDir, finalName);
          try {
            await fs.promises.writeFile(finalPath, body);
          } catch (retryErr) {
            logger.error("file upload write error (retry)", retryErr);
            res.status(500).json({ ok: false, error: "failed to write file" });
            return;
          }
        } else {
          logger.error("file upload write error", err);
          res.status(500).json({ ok: false, error: "failed to write file" });
          return;
        }
      }
      logger.log("file uploaded", finalPath, `bytes=${body.length}`);
      res.json({ ok: true, path: finalPath, filename: finalName });
    }
  );

  if (deps.extensions) {
    app.use("/api/push", requireApiAuth, deps.extensions.notificationRoutes);

    app.get("/api/state/:session", requireApiAuth, (req, res) => {
      const snapshot = deps.extensions!.getSnapshot(getSingleParam(req.params.session));
      if (snapshot) {
        res.json(snapshot);
      } else {
        res.status(404).json({ error: "session not found or no state tracked" });
      }
    });

    app.get("/api/scrollback/:session", requireApiAuth, (req, res) => {
      const sessionName = getSingleParam(req.params.session);
      const from = parseInt(req.query.from as string) || 0;
      const count = parseInt(req.query.count as string) || 100;
      const lines = deps.extensions!.getScrollback(sessionName, from, count);
      res.json({ from, count: lines.length, lines });
    });

    app.get("/api/gastown/:session", requireApiAuth, (req, res) => {
      const info = deps.extensions!.getGastownInfo(getSingleParam(req.params.session));
      res.json(info);
    });

    app.get("/api/stats/bandwidth", requireApiAuth, (_req, res) => {
      res.json(deps.extensions!.getBandwidthStats());
    });

    app.get("/api/files", requireApiAuth, (_req, res) => {
      try {
        const cwd = process.cwd();
        const entries = fs.readdirSync(cwd, { withFileTypes: true })
          .filter((entry) => !entry.name.startsWith("."))
          .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
          }));
        res.json({ path: cwd, entries });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/files/*filePath", requireApiAuth, (req, res) => {
      const rawPath = Array.isArray(req.params.filePath)
        ? req.params.filePath.join("/")
        : String(req.params.filePath ?? "");
      const filePath = path.resolve(process.cwd(), rawPath);
      if (!filePath.startsWith(process.cwd())) {
        res.status(403).json({ error: "path traversal not allowed" });
        return;
      }
      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          const entries = fs.readdirSync(filePath, { withFileTypes: true })
            .filter((entry) => !entry.name.startsWith("."))
            .map((entry) => ({
              name: entry.name,
              type: entry.isDirectory() ? "directory" : "file",
            }));
          res.json({ path: filePath, entries });
        } else {
          if (stat.size > 1_048_576) {
            res.status(413).json({ error: "file too large (>1MB)" });
            return;
          }
          const content = fs.readFileSync(filePath, "utf8");
          res.json({ path: filePath, content, size: stat.size });
        }
      } catch {
        res.status(404).json({ error: `not found: ${rawPath}` });
      }
    });
  }

  app.use(express.static(config.frontendDir));
  app.get(frontendFallbackRoute, (req, res) => {
    if (isWebSocketPath(req.path) || req.path.startsWith("/api/")) {
      res.status(404).end();
      return;
    }

    res.sendFile(path.join(config.frontendDir, "index.html"), (error) => {
      if (error) {
        res.status(500).send("Frontend not built. Run npm run build:frontend");
      }
    });
  });
};
