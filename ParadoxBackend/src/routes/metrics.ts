import crypto from "node:crypto";
import { Request, Response, Router } from "express";
import { RenderMetrics } from "../observability/metrics";

export const metricsRouter = Router();

function rawLoopback(req: Request): boolean {
    const address = req.socket.remoteAddress ?? "";
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function configuredToken(): string | undefined {
    const token = process.env.MYSTICPARADOX_METRICS_TOKEN?.trim();
    return token == undefined || token.length === 0 ? undefined : token;
}

function suppliedToken(req: Request): string | undefined {
    const authorization = req.header("authorization");
    if (authorization?.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
    const header = req.header("x-mysticparadox-metrics-token");
    return header?.trim() || undefined;
}

function authorized(req: Request): boolean {
    const expected = configuredToken();
    if (expected == undefined) return process.env.NODE_ENV !== "production" && rawLoopback(req);
    const actual = suppliedToken(req);
    if (actual == undefined) return false;
    const expectedBytes = Buffer.from(expected, "utf8");
    const actualBytes = Buffer.from(actual, "utf8");
    return expectedBytes.length === actualBytes.length && crypto.timingSafeEqual(expectedBytes, actualBytes);
}

metricsRouter.get("/internal/v1/metrics", (req, res) => {
    if (!authorized(req)) {
        res.status(process.env.MYSTICPARADOX_METRICS_TOKEN ? 401 : 503).type("text/plain").send("metrics unavailable\n");
        return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.type("text/plain; version=0.0.4").send(RenderMetrics());
});

export const MetricsRouteInternals = { rawLoopback, configuredToken, suppliedToken, authorized };
