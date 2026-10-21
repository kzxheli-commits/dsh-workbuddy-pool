/**
 * The one-off "DeepSeek 模型服务异常额外补偿" campaign (500 credits).
 *
 * This is not a daily task: the upstream opens a single compensation offer per
 * account, it pays once, and it closes for good. Two consequences shape the
 * module:
 *
 * 1. The row must disappear from the card when the campaign is over, not sit
 *    there failing forever. The campaign's own end time is the authority when
 *    the gateway reports one; the operator-supplied `CAMPAIGN_DEADLINE_MS` is the
 *    backstop for accounts whose status call is unavailable.
 * 2. It must never be presented as a daily job with a clock time, because a
 *    "daily" row would imply it pays every day.
 *
 * The endpoints come from the reference proxy
 * (`2861292267/DSH-Official-WorkBuddy-Credit-Proxy`, `lib/index.js`), which
 * transcribed them from the user-centre frontend bundle:
 *
 *   POST <billing>/billing/meter/compensation-status   -> {claimed, active, credit_num, end_time}
 *   POST <billing>/billing/meter/claim-compensation    -> {credit_num | credit, claimed}
 *
 * Two details are deliberate and both are load-bearing:
 *
 * - **No `/v2` prefix.** The check-in family lives at `/v2/billing/meter/*`; the
 *   campaign family lives at `/billing/meter/*`. With the prefix the route
 *   answers 404 and the feature is dead without a diagnostic.
 * - **POST with an empty JSON body.** The GET form of the same path 404s, and
 *   the frontend calls both of them through `.post`.
 *
 * @module dsh-workbuddy-pool/campaign
 */

/**
 * Last instant the campaign is offered, as an epoch millisecond value.
 *
 * Beijing time 2026-10-22 00:00:00 = 2026-10-21T16:00:00Z. From that instant the
 * card stops showing the row and the scheduler stops running the job: after the
 * offer closed, a claim call can only fail, and a visible-but-failing row is
 * worse than no row.
 */
export const CAMPAIGN_DEADLINE_MS = Date.UTC(2026, 9, 21, 16, 0, 0, 0);

/** The campaign's advertised size, used only when the gateway omits the amount. */
export const CAMPAIGN_CREDIT = 500;

/** Whether the campaign is still within its offering window at `now`. */
export function campaignOpen(now = Date.now()) {
  return now < CAMPAIGN_DEADLINE_MS;
}

/** ISO-8601 spelling of the deadline, for the card's tooltip. */
export function campaignDeadlineIso() {
  return new Date(CAMPAIGN_DEADLINE_MS).toISOString();
}
