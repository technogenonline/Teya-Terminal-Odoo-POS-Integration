import { TicketScreen } from "@point_of_sale/app/screens/ticket_screen/ticket_screen";
import { patch } from "@web/core/utils/patch";

patch(TicketScreen.prototype, {
    async addAdditionalRefundInfo(order, destinationOrder) {
        destinationOrder.taplink_gateway_ref = order.taplink_gateway_ref;
        destinationOrder.taplink_tx_ref = order.taplink_tx_ref;
        destinationOrder.taplink_gateway_payload = order.taplink_gateway_payload;
        await super.addAdditionalRefundInfo(...arguments);
    },
});
