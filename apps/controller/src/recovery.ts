export type RecoveryAction = "restart-pipeline" | "restart-engine" | "switch-path";

export interface RecoveryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RecoveryState {
  /** Failed attempts since the stream was last healthy. */
  failures: number;
  /** When the previous recovery action ran. */
  lastActionAt: number | undefined;
}

export interface RecoveryDecision {
  action: RecoveryAction;
  /** Earliest time the action may run (exponential backoff). */
  notBefore: number;
}

/**
 * The recovery ladder. Cheap, local fixes come first; the network path only changes after
 * restarting the pipeline and the engine did not help, because a path switch is the most visible
 * change for viewers.
 *
 * failures: 0 → restart pipeline, 1 → restart pipeline, 2 → restart engine, 3 → switch path,
 * then alternate engine restart and path switch with growing delays.
 *
 * With `freshEngine`, every try replaces the engine. That is for a source the transcoder found
 * stale: while the broadcast sends nothing new, the engine whose live edge stopped goes, so it
 * can't keep its old window, and a new one looks for the broadcast from scratch; and an engine
 * that serves a broadcast that goes on too far behind keeps doing so, where a new one starts close
 * to the live edge. Every second try does that on another path, when there is one to switch to.
 * (On a shared engine, other streams play from it: only the stream's session starts again.)
 */
export function nextRecovery(
  state: RecoveryState,
  policy: RecoveryPolicy,
  canSwitchPath: boolean,
  freshEngine = false,
): RecoveryDecision {
  const { failures } = state;
  let action: RecoveryAction;
  if (freshEngine) {
    action = canSwitchPath && failures % 2 === 1 ? "switch-path" : "restart-engine";
  } else if (failures < 2) {
    action = "restart-pipeline";
  } else if (failures === 2) {
    action = "restart-engine";
  } else if (canSwitchPath && failures % 2 === 1) {
    action = "switch-path";
  } else {
    action = "restart-engine";
  }
  const delay = failures === 0 ? 0 : Math.min(policy.baseDelayMs * 2 ** (failures - 1), policy.maxDelayMs);
  return { action, notBefore: (state.lastActionAt ?? 0) + delay };
}
