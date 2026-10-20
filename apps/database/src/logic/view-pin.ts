/**
 * Pin a view (9.12.35). A user-created view is a real `ListView/v1` entity,
 * so it pins through the same dashboard surface as any object (pin-any-
 * object) — and the Database opener lands on that exact view when the pin is
 * opened. A vault-derived view is regenerated per device (its tweaks live in
 * local kv), so it has no entity to pin; the item says why instead of
 * vanishing.
 */

export enum ViewPinAvailability {
	/** The app has no pin surface (capability or service missing) — omit. */
	Unsupported = "unsupported",
	/** A vault-derived view — shown disabled with a hint. */
	NotAnObject = "not-an-object",
	Pinnable = "pinnable",
}

const PIN_CAPABILITY = "dashboard.pin";

export function canPinToDashboard(
	capabilities: ReadonlyArray<string> | undefined,
	hasService: boolean,
): boolean {
	if (!hasService || !capabilities) return false;
	return capabilities.some((c) => c === PIN_CAPABILITY || c.startsWith(`${PIN_CAPABILITY}:`));
}

export function viewPinAvailability(
	viewId: string,
	isVaultDerived: (id: string) => boolean,
	pinSupported: boolean,
): ViewPinAvailability {
	if (!pinSupported) return ViewPinAvailability.Unsupported;
	return isVaultDerived(viewId) ? ViewPinAvailability.NotAnObject : ViewPinAvailability.Pinnable;
}
