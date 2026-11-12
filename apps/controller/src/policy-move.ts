import type { StreamState } from "@aceswarm/shared/api-types";
import { describeError } from "@aceswarm/shared/http";
import type { Logger } from "@aceswarm/shared/logger";
import { nextRecovery, type RecoveryPolicy, type RecoveryState } from "./recovery.ts";
import type { MoveSlots, StreamPaths } from "./stream-paths.ts";

/** What moving a stream off a path the network policy turned off needs from its supervisor. */
export interface PolicyMove {
  paths: StreamPaths;
  /** The path it is on, which the policy no longer allows. */
  from: string | null;
  recovery: RecoveryState;
  policy: RecoveryPolicy;
  /** Slots shared by every stream that moves off a path that is off. */
  slots: MoveSlots | undefined;
  now: () => number;
  logger: Logger;
  setState: (state: StreamState, message: string | null) => void;
  /** Moves the stream to another path; throws when the move fails. */
  switchPath: () => Promise<void>;
}

/**
 * The stream uses a path the policy no longer allows: WireGuard only was turned on while it was
 * on the direct path. The gateway has already cut its engine off, so it moves now rather than
 * once the stall is noticed. This is not a recovery: the stream was healthy. Failed moves wait
 * like recovery steps do, so a VPN that can't carry the stream doesn't churn engines, and only a
 * few streams move at once, because each move starts a second engine. Returns the stream's
 * recovery state afterwards.
 */
export async function leaveDisallowedPath(move: PolicyMove): Promise<RecoveryState> {
  const { paths, recovery, slots, logger } = move;
  if (!paths.known || paths.noneUsable()) {
    // While the gateway is unreachable its paths are unknown: nothing to move to yet.
    move.setState("stalled", paths.known ? paths.waitingMessage() : "waiting for the network gateway");
    return recovery;
  }
  const from = move.from ?? "?";
  const wait = nextRecovery(recovery, move.policy, true).notBefore - move.now();
  if (wait > 0 || slots?.tryTake() === false) {
    const reason = wait > 0 ? `moving again in ${String(Math.ceil(wait / 1000))}s` : "other streams move first";
    move.setState("stalled", `path ${from} is off; ${reason}`);
    return recovery;
  }
  logger.info({ path: from }, "path is off (WireGuard only); moving the stream");
  try {
    await move.switchPath();
    // Video arrived on the new path.
    return { failures: 0, lastActionAt: undefined };
  } catch (error) {
    move.setState("stalled", `moving off ${from} failed: ${describeError(error)}`);
    logger.warn({ err: error, path: from }, "could not move the stream off a path that is off");
    // The wait counts from the failure: a move can take until the handover timeout to fail.
    return { failures: recovery.failures + 1, lastActionAt: move.now() };
  } finally {
    slots?.release();
  }
}
