import { Router } from "express";
import { HasAdminAuth } from "../../middleware/HasAdminAuth";
import { AcknowledgeOperationsAlert, UpdateCoopTransport, UpdateP2PEmergencyStop, UpdateRewardRollout } from "../controllers/p2pAdminOperations";

// Operator actions of the player-hosted hunt module. Mounted after the shared admin router, whose
// /admin/v1 middleware has already applied the origin check and security headers.
export const p2pAdminRouter = Router();

p2pAdminRouter.patch("/admin/v1/operations/p2p-emergency-stop", HasAdminAuth, UpdateP2PEmergencyStop);
p2pAdminRouter.patch("/admin/v1/operations/reward-rollout", HasAdminAuth, UpdateRewardRollout);
p2pAdminRouter.patch("/admin/v1/operations/coop-transport", HasAdminAuth, UpdateCoopTransport);
p2pAdminRouter.patch("/admin/v1/operations/alerts/:alertId/ack", HasAdminAuth, AcknowledgeOperationsAlert);
