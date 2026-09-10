import { _t } from "@web/core/l10n/translation";
import { PaymentInterface } from "@point_of_sale/app/payment/payment_interface";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { register_payment_method } from "@point_of_sale/app/store/pos_store";
import { sprintf } from "@web/core/utils/strings";
import {
    isGatewayStatusFinal,
    normalizeGatewayStatus,
    FINAL_GATEWAY_STATUSES,
} from "@teya_payment_terminal_integration/app/taplink_status_normalizer";
import {
    amountToMinorUnits,
    getTaplinkTerminalChargeAmount,
    roundPaymentAmount,
} from "@teya_payment_terminal_integration/app/taplink_split_math";

const IDEMPOTENCY_KEY_MAX_LEN = 64;
const POLL_INITIAL_DELAY_MS = 800;
const POLL_INTERVAL_MS = 2500;

function buildIdempotencyKey(lineUuid, attempt) {
    const linePart = lineUuid.replace(/-/g, "").slice(0, 24);
    const key = `${linePart}-${attempt}-${Date.now().toString(36)}`;
    return key.length <= IDEMPOTENCY_KEY_MAX_LEN ? key : key.slice(0, IDEMPOTENCY_KEY_MAX_LEN);
}

export class PaymentTaplinkInterface extends PaymentInterface {
    setup() {
        super.setup(...arguments);
        this._lineResolvers = {};
        this._attemptCounterByLine = {};
        this._handledResponseByLine = {};
        this._pollCancelByLine = {};
        this._activeLineUuid = null;
        this._chargedAmountByLine = {};
    }

    assignRequestId(id, lineUuid = this._activeLineUuid) {
        this.payment_request_id = id;
        const line = lineUuid ? this._lineByUuid(lineUuid) : null;
        if (line && id) {
            line.payment_request_id = id;
        }
    }

    _lineByUuid(uuid) {
        const order = this.pos.get_order();
        return order?.payment_ids?.find((paymentLine) => paymentLine.uuid === uuid);
    }

    _bumpAttempt(lineUuid) {
        this._attemptCounterByLine[lineUuid] = (this._attemptCounterByLine[lineUuid] || 0) + 1;
        return this._attemptCounterByLine[lineUuid];
    }

    _haltPolling(lineUuid) {
        const cancel = this._pollCancelByLine[lineUuid];
        if (cancel) {
            cancel();
            delete this._pollCancelByLine[lineUuid];
        }
    }

    _resetLineSession(lineUuid) {
        this._haltPolling(lineUuid);
        delete this._handledResponseByLine[lineUuid];
        this._activeLineUuid = lineUuid;
        delete this._lineResolvers[lineUuid];
        if (this._activeLineUuid === lineUuid) {
            this.payment_request_id = null;
        }
    }

    _responseAlreadyHandled(lineUuid) {
        return Boolean(this._handledResponseByLine[lineUuid]);
    }

    _flagResponseHandled(lineUuid) {
        this._handledResponseByLine[lineUuid] = true;
    }

    _decorateStatusPayload(response, line) {
        if (!response || typeof response !== "object") {
            return response;
        }
        const enriched = { ...response };
        if (!enriched.payment_request_id) {
            enriched.payment_request_id =
                line?.payment_request_id || this.payment_request_id || null;
        }
        if (enriched.status) {
            enriched.status = normalizeGatewayStatus(enriched.status);
        }
        return enriched;
    }

    _belongsToLine(response, line) {
        const responseId = response?.payment_request_id;
        if (!responseId) {
            return true;
        }
        const lineId = line?.payment_request_id;
        const activeId = this.payment_request_id;
        if (lineId && String(responseId) === String(lineId)) {
            return true;
        }
        if (activeId && String(responseId) === String(activeId)) {
            return true;
        }
        if (
            this._activeLineUuid === line?.uuid &&
            activeId &&
            String(responseId) === String(activeId)
        ) {
            return true;
        }
        return !lineId && !activeId;
    }

    send_payment_request(uuid) {
        super.send_payment_request(uuid);
        this._resetLineSession(uuid);
        this._bumpAttempt(uuid);
        return this._submitPayment(uuid);
    }

    _resolveChargeAmount(line) {
        const order = this.pos.get_order();
        const currency = this.pos.currency;
        const chargeAmount = getTaplinkTerminalChargeAmount(order, line, currency);
        this._chargedAmountByLine[line.uuid] = chargeAmount;
        if (chargeAmount > 0) {
            line.set_amount(chargeAmount);
        }
        return chargeAmount;
    }

    _submitPayment(uuid) {
        const line = this._lineByUuid(uuid);
        if (!line) {
            return Promise.resolve(false);
        }

        const chargeAmount = this._resolveChargeAmount(line);
        if (chargeAmount <= 0) {
            this._showError(_t("Cannot process transactions with negative amount."));
            return Promise.resolve(false);
        }

        const payload = this._buildSalePayload(line, chargeAmount);
        return this._rpcCreatePayment(payload, uuid).then((response) => {
            return this._onCreatePaymentResponse(response, uuid);
        });
    }

    _onCreatePaymentResponse(response, uuid) {
        const line = this._lineByUuid(uuid);
        if (!line) {
            return false;
        }

        response = this._decorateStatusPayload(response, line);

        if (response.status_code) {
            const hint =
                response.message ||
                _t("Check Teya credentials, Payment mode (sandbox vs production), and store/reader access.");
            this._showError(
                response.status_code === 401
                    ? sprintf(_t("Authentication failed: %s"), hint)
                    : sprintf(
                          _t("Teya refused the payment request (%s): %s"),
                          String(response.status_code),
                          hint
                      )
            );
            line.set_payment_status("force_done");
            return false;
        }

        if (!response.payment_request_id) {
            this._showError(
                _t(
                    "Teya did not return a payment request id. See Odoo server log for the HTTP response."
                )
            );
            line.set_payment_status("force_done");
            return false;
        }

        this.assignRequestId(response.payment_request_id, uuid);
        const status = normalizeGatewayStatus(response?.status);
        if (status === "REJECT" || FINAL_GATEWAY_STATUSES.has(status)) {
            return this.applyGatewayStatus(response, uuid);
        }

        line.set_payment_status("waitingCard");
        this._beginStatusPolling(uuid);
        return this._awaitLineConfirmation(uuid);
    }

    _beginStatusPolling(uuid) {
        this._haltPolling(uuid);
        const poll = async () => {
            const line = this._lineByUuid(uuid);
            if (!line || this._responseAlreadyHandled(uuid)) {
                this._haltPolling(uuid);
                return;
            }
            if (line.get_payment_status() === "retry") {
                this._haltPolling(uuid);
                return;
            }
            const requestId = line.payment_request_id || this.payment_request_id;
            if (!requestId) {
                return;
            }
            try {
                const result = await this.pos.data.silentCall(
                    "pos.payment.method",
                    "taplink_poll_payment_request",
                    [[this.payment_method_id.id], requestId, this.pos.session.id]
                );
                this._onPollTick(result, uuid);
            } catch (error) {
                console.error("Taplink status poll failed", error);
            }
        };
        const timeoutId = setTimeout(poll, POLL_INITIAL_DELAY_MS);
        const intervalId = setInterval(poll, POLL_INTERVAL_MS);
        this._pollCancelByLine[uuid] = () => {
            clearTimeout(timeoutId);
            clearInterval(intervalId);
        };
    }

    _onPollTick(result, uuid) {
        if (!result || result.status_code) {
            return;
        }
        if (result.status === "pending") {
            return;
        }
        const line = this._lineByUuid(uuid);
        if (!line || this._responseAlreadyHandled(uuid)) {
            return;
        }
        const enriched = this._decorateStatusPayload(result, line);
        if (!this._belongsToLine(enriched, line)) {
            return;
        }
        const status = normalizeGatewayStatus(enriched.status);
        if (isGatewayStatusFinal(status)) {
            void this.applyGatewayStatus(enriched, uuid);
        }
    }

    _awaitLineConfirmation(uuid) {
        return new Promise((resolve) => {
            this._lineResolvers[uuid] = resolve;
        });
    }

    forceCompleteLine(line) {
        if (!line) {
            return false;
        }
        const uuid = line.uuid;
        if (this._responseAlreadyHandled(uuid)) {
            return true;
        }
        this._flagResponseHandled(uuid);
        this._haltPolling(uuid);
        this.payment_request_id = null;

        const resolver = this._lineResolvers?.[uuid];
        if (resolver) {
            delete this._lineResolvers[uuid];
            resolver(true);
            return true;
        }
        line.handle_payment_response(true);
        return true;
    }

    async send_payment_cancel(order, uuid) {
        super.send_payment_cancel(order, uuid);
        const line = this._lineByUuid(uuid);
        const paymentRequestId = line?.payment_request_id || this.payment_request_id;
        this._flagResponseHandled(uuid);
        this._haltPolling(uuid);
        this.payment_request_id = null;

        if (paymentRequestId) {
            try {
                await this.pos.data.silentCall(
                    "pos.payment.method",
                    "taplink_abort_payment_request",
                    [[this.payment_method_id.id], paymentRequestId]
                );
            } catch (error) {
                console.error("Taplink cancel error:", error);
            }
        }

        const resolver = this._lineResolvers?.[uuid];
        if (resolver) {
            delete this._lineResolvers[uuid];
            resolver(false);
        }

        return true;
    }

    _rpcCreatePayment(data, lineUuid, operation = false) {
        const attempt = this._attemptCounterByLine[lineUuid] || 1;
        const order_token = buildIdempotencyKey(lineUuid, attempt);
        return this.pos.data
            .silentCall("pos.payment.method", "taplink_create_payment_request", [
                [this.payment_method_id.id],
                data,
                this.pos.config.id,
                order_token,
                operation,
            ])
            .catch(this._handle_odoo_connection_failure.bind(this));
    }

    pendingTaplinkLine() {
        return this.pos.getPendingPaymentLine("taplink");
    }

    _handle_odoo_connection_failure(data = {}) {
        const line = this.pendingTaplinkLine();
        if (line) {
            line.set_payment_status("force_done");
        }
        this._showError(
            _t(
                "Could not connect to the Odoo server, please check your internet connection and try again."
            )
        );

        return Promise.reject(data);
    }

    _buildSalePayload(line, chargeAmount) {
        const order = this.pos.get_order();
        const config = this.pos.config;
        const currency = this.pos.currency;
        const refStr = String(order.pos_reference || order.getName?.() || order.tracking_number || "");
        const parts = refStr.trim().split(/\s+/);
        let merchant_reference = parts.length > 1 ? parts[1] : refStr || String(order.uuid);

        const plan = order.getTaplinkEqualSplitState?.();
        const splitActive = Boolean(plan?.active);
        if (splitActive) {
            merchant_reference = `${merchant_reference}-S${plan.index + 1}`;
        }

        const amountMinor =
            chargeAmount != null
                ? amountToMinorUnits(chargeAmount, currency)
                : amountToMinorUnits(line.amount, currency);

        const base = {
            epos_instance_id: config.name,
            merchant_reference,
            requested_amount: {
                currency: currency?.name || "GBP",
                amount: amountMinor,
                tip: 0,
            },
            transaction_type: "SALE",
        };

        if (!splitActive && order?.taplink_gateway_ref && order?.taplink_gateway_payload) {
            return {
                ...base,
                gateway_payment_id: order.taplink_gateway_ref,
                transaction_id: order.taplink_tx_ref,
            };
        }
        return base;
    }

    _showError(msg, title) {
        if (!title) {
            title = _t("Teya Error");
        }
        this.env.services.dialog.add(AlertDialog, {
            title: title,
            body: msg,
        });
    }

    _finishLine(line, isPaymentSuccessful) {
        const resolver = this._lineResolvers?.[line.uuid];
        if (resolver) {
            delete this._lineResolvers[line.uuid];
            resolver(isPaymentSuccessful);
            return;
        }
        line.handle_payment_response(isPaymentSuccessful);
    }

    async applyGatewayStatus(response, uuid = this._activeLineUuid) {
        const line = uuid ? this._lineByUuid(uuid) : this.pendingTaplinkLine();
        if (!line) {
            return false;
        }

        response = this._decorateStatusPayload(response, line);
        if (this._responseAlreadyHandled(line.uuid)) {
            return false;
        }
        if (!this._belongsToLine(response, line)) {
            return false;
        }

        this._flagResponseHandled(line.uuid);
        this._haltPolling(line.uuid);
        this.payment_request_id = null;

        const status = normalizeGatewayStatus(response?.status);
        const isPaymentSuccessful = status === "SUCCESSFUL";

        if (isPaymentSuccessful) {
            const order = this.pos.get_order();
            const plan = order.getTaplinkEqualSplitState?.();
            const persistPayload =
                !plan?.active || (plan.active && plan.index >= plan.count - 1);
            if (persistPayload) {
                order.storeTaplinkGatewayPayload(response);
            }
            if (response.payment_request_id) {
                line.payment_request_id = response.payment_request_id;
            }
            const charged =
                this._chargedAmountByLine[line.uuid] ??
                roundPaymentAmount(line.amount, this.pos.currency);
            if (charged > 0) {
                line.set_amount(charged);
            }
            delete this._chargedAmountByLine[line.uuid];
        } else if (status === "CANCELLED") {
            this._showError(_t("Payment was cancelled on the Teya terminal."));
        } else if (status === "FAILED") {
            this._showError(_t("Payment was declined or failed on the Teya terminal."));
        } else {
            this._showError(sprintf(_t("Message from Teya: Payment %s"), response?.status || status));
        }

        this._finishLine(line, isPaymentSuccessful);
        if (isPaymentSuccessful && typeof this.pos.taplinkOnGatewaySettled === "function") {
            this.pos.taplinkOnGatewaySettled(line, true);
        }
        return isPaymentSuccessful;
    }
}

register_payment_method("taplink", PaymentTaplinkInterface);
