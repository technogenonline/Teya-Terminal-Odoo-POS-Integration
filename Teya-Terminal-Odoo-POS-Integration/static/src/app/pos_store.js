import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/store/pos_store";

patch(PosStore.prototype, {
    async setup() {
        await super.setup(...arguments);
        this.data.connectWebSocket("TAPLINK_PAYMENT_STATUS", (payload) => {
            if (payload.config_id !== this.config.id) {
                return;
            }
            const paymentRequestId = payload.payment_request_id;
            let response = payload.response;
            if (!response || !paymentRequestId) {
                return;
            }
            if (!response.payment_request_id) {
                response = { ...response, payment_request_id: paymentRequestId };
            }

            const terminalKey = "taplink";
            for (const order of this.models["pos.order"].getAll()) {
                const lineByRequestId = order.payment_ids.find(
                    (paymentLine) =>
                        paymentLine.payment_method_id.use_payment_terminal === terminalKey &&
                        !paymentLine.is_done() &&
                        paymentLine.payment_request_id &&
                        String(paymentLine.payment_request_id) === String(paymentRequestId)
                );
                if (lineByRequestId) {
                    const iface = lineByRequestId.payment_method_id.payment_terminal;
                    void iface?.applyGatewayStatus(response, lineByRequestId.uuid);
                    return;
                }
            }

            for (const order of this.models["pos.order"].getAll()) {
                const pendingLine = order.payment_ids.find(
                    (paymentLine) =>
                        paymentLine.payment_method_id.use_payment_terminal === terminalKey &&
                        !paymentLine.is_done() &&
                        ["waitingCard", "waiting", "waitingCancel", "pending"].includes(
                            paymentLine.get_payment_status()
                        )
                );
                if (!pendingLine) {
                    continue;
                }
                const iface = pendingLine.payment_method_id.payment_terminal;
                if (
                    iface &&
                    iface._activeLineUuid === pendingLine.uuid &&
                    (!iface.payment_request_id ||
                        String(iface.payment_request_id) === String(paymentRequestId))
                ) {
                    if (!pendingLine.payment_request_id) {
                        pendingLine.payment_request_id = paymentRequestId;
                    }
                    void iface.applyGatewayStatus(response, pendingLine.uuid);
                    return;
                }
            }
        });
    },
});
