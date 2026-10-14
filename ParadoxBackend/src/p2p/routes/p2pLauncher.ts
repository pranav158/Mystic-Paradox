import { Request, Response, Router } from "express";
import { CreateHostBootstrap, CreateJoinBootstrap, MarkLocalRouteReady } from "../controllers/p2pLauncher";
import { HasLauncherAuth } from "../../middleware/HasLauncherAuth";
import { RequireActiveAccount } from "../../middleware/RequireActiveAccount";
import { LauncherApiError, SendLauncherError } from "../security/p2pErrors";
import { logger } from "../../logger";
import { GetRequestId } from "../../observability/requestContext";
import { AcknowledgeP2PControl, PollP2PControl } from "../controllers/p2pControl";
import { RecordParticipantObservation, RespondToHostOffer, SubmitHostPresence } from "../controllers/p2pHostLifecycle";
import { CreateIceTransportConfig, SubmitIceSignal } from "../controllers/p2pIce";

export const p2pLauncherRouter = Router();

// [2026-10-14] A deactivated account (a pending deletion) may not host or join a hunt: the bootstraps, the host presence and
// the host's acceptance of an offer answer ACCOUNT_DEACTIVATED. Running sessions (route-ready, transport, signals, control)
// are unchanged so a hunt in progress can finish.
const ActiveAccount = RequireActiveAccount({ consent: false });

async function Handle(res: Response, action: () => Promise<unknown>): Promise<void> {
    try {
        res.status(200).json(await action());
    } catch (error) {
        if (error instanceof LauncherApiError) {
            SendLauncherError(res, error);
            return;
        }
        logger.error(`Unhandled launcher P2P error requestId=${GetRequestId() ?? "missing"}: ${error}`);
        SendLauncherError(res, new LauncherApiError("INTERNAL", "The player-host launcher request failed."));
    }
}

p2pLauncherRouter.post("/launcher/v1/p2p/hunts/:sessionId/host-bootstrap", HasLauncherAuth, ActiveAccount, (req: Request, res: Response) =>
    Handle(res, () => CreateHostBootstrap((req as any).LauncherAuthData.userId, String(req.params.sessionId)))
);

p2pLauncherRouter.post("/launcher/v1/p2p/hunts/:sessionId/join-bootstrap", HasLauncherAuth, ActiveAccount, (req: Request, res: Response) =>
    Handle(res, () => CreateJoinBootstrap((req as any).LauncherAuthData.userId, String(req.params.sessionId)))
);

p2pLauncherRouter.post("/launcher/v1/p2p/hunts/:sessionId/route-ready", HasLauncherAuth, (req: Request, res: Response) =>
    Handle(res, () => MarkLocalRouteReady((req as any).LauncherAuthData.userId, String(req.params.sessionId), req.body))
);

// [2026-10-13] ICE co-op transport: ICE servers and pair keys for one participant, and host-joiner signals.
p2pLauncherRouter.post("/launcher/v1/p2p/hunts/:sessionId/transport-config", HasLauncherAuth, (req: Request, res: Response) =>
    Handle(res, () => CreateIceTransportConfig((req as any).LauncherAuthData.userId, String(req.params.sessionId), req.body))
);

p2pLauncherRouter.post("/launcher/v1/p2p/hunts/:sessionId/signal", HasLauncherAuth, (req: Request, res: Response) =>
    Handle(res, () => SubmitIceSignal((req as any).LauncherAuthData.userId, String(req.params.sessionId), req.body))
);

p2pLauncherRouter.get("/launcher/v1/p2p/control", HasLauncherAuth, (req: Request, res: Response) =>
    Handle(res, () => PollP2PControl(
        (req as any).LauncherAuthData.userId,
        req.query.afterSequence,
        req.query.waitMs
    ))
);

p2pLauncherRouter.post("/launcher/v1/p2p/control/:messageId/ack", HasLauncherAuth, (req: Request, res: Response) =>
    Handle(res, () => AcknowledgeP2PControl(
        (req as any).LauncherAuthData.userId,
        String(req.params.messageId)
    ))
);

p2pLauncherRouter.post("/launcher/v1/p2p/host-presence", HasLauncherAuth, ActiveAccount, (req: Request, res: Response) =>
    Handle(res, () => SubmitHostPresence((req as any).LauncherAuthData.userId, req.body))
);

p2pLauncherRouter.post("/launcher/v1/p2p/host-offers/:offerId/respond", HasLauncherAuth, ActiveAccount, (req: Request, res: Response) =>
    Handle(res, () => RespondToHostOffer(
        (req as any).LauncherAuthData.userId,
        String(req.params.offerId),
        req.body
    ))
);

p2pLauncherRouter.post("/launcher/v1/p2p/hunts/:sessionId/observation", HasLauncherAuth, (req: Request, res: Response) =>
    Handle(res, () => RecordParticipantObservation(
        (req as any).LauncherAuthData.userId,
        String(req.params.sessionId),
        req.body
    ))
);
