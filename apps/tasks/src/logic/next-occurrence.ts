/**
 * Tasks' stable import path for `nextOccurrence` — the implementation
 * moved to `@brainstorm-os/sdk-types` (`recurrence-next.ts`) at 9.15.10 so
 * the single-next-step engine lives beside the `Recurrence` union + the
 * 9.15.5 window-materializer instead of being a Tasks-app silo the
 * comment here always said should be SDK-extracted. Re-exported (not
 * inlined) so existing `./next-occurrence` imports + the
 * behaviour-preservation test keep working unchanged.
 */

export { nextOccurrence } from "@brainstorm-os/sdk-types";
