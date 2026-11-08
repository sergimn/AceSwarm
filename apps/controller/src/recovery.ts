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
 * While the broadcast sends nothing new (`staleSource`), every other try is only a new session,
 * and the others a new engine (every second one of those a path switch, when there is a path to
 * switch to): the broadcast coming back is what helps, and a new session finds that out as well
 * as a new engine, without the churn. An engine whose state is stuck gets replaced all the same.
 */
export function nextRecovery(
  state: RecoveryState,
  policy: RecoveryPolicy,
  canSwitchPath: boolean,
  staleSource = false,
): RecoveryDecision {
  const { failures } = state;
  let action: RecoveryAction;
  if (staleSource) {
    if (failures % 2 === 0) {
      action = "restart-pipeline";
    } else {
      action = canSwitchPath && failures % 4 === 3 ? "switch-path" : "restart-engine";
    }
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
