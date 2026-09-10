/** @odoo-module */

const FINAL_GATEWAY_STATUSES = new Set(["SUCCESSFUL", "CANCELLED", "FAILED"]);

/**
 * Normalize gateway status strings from API / webhooks.
 * @param {string|undefined} status
 * @returns {string}
 */
export function normalizeGatewayStatus(status) {
    const normalized = (status || "").toUpperCase();
    if (["SUCCESS", "APPROVED", "COMPLETED", "CAPTURED"].includes(normalized)) {
        return "SUCCESSFUL";
    }
    return normalized;
}

export function isGatewayStatusFinal(status) {
    return FINAL_GATEWAY_STATUSES.has(normalizeGatewayStatus(status));
}

export { FINAL_GATEWAY_STATUSES };
