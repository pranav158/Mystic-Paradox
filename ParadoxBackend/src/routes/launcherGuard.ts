import { Request, Response, Router } from "express";
import { GetLauncherGuardStatus, StartLauncherGuard, SubmitLauncherGuardHeartbeat } from "../controllers/launcherGuard";
import { HasLauncherAuth } from "../middleware/HasLauncherAuth";
import { LauncherApiError, SendLauncherError } from "../security/launcherErrors";
import { logger } from "../logger";
import { GetRequestId } from "../observability/requestContext";

export const launcherGuardRouter = Router();

async function Handle(res: Response, action: () => Promise<unknown>): Promise<void> {
    try { res.status(200).json(await action()); }
    catch (error) {
        if (error instanceof LauncherApiError) { SendLauncherError(res, error); return; }
        logger.error(`Unhandled Launcher Guard error requestId=${GetRequestId() ?? "missing"}: ${error}`);
        SendLauncherError(res, new LauncherApiError("INTERNAL", "Launcher Guard failed."));
    }
}

launcherGuardRouter.post("/launcher/v1/guard/sessions", HasLauncherAuth, (req: Request, res: Response) =>
    Handle(res, () => StartLauncherGuard((req as any).LauncherAuthData.userId, req.body)));

launcherGuardRouter.post("/launcher/v1/guard/heartbeat", HasLauncherAuth, (req: Request, res: Response) =>
    Handle(res, () => SubmitLauncherGuardHeartbeat((req as any).LauncherAuthData.userId, req.body)));

launcherGuardRouter.get("/launcher/v1/guard/sessions/:guardSessionId", HasLauncherAuth, (req: Request, res: Response) =>
    Handle(res, () => GetLauncherGuardStatus((req as any).LauncherAuthData.userId, String(req.params.guardSessionId))));
