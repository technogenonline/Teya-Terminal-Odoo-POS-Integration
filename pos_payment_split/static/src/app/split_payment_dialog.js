/** @odoo-module */

import { _t } from "@web/core/l10n/translation";
import { Dialog } from "@web/core/dialog/dialog";
import { useService } from "@web/core/utils/hooks";
import { parseFloat as parseMonetary } from "@web/views/fields/parsers";
import { Component, useState } from "@odoo/owl";
import {
    BACKSPACE,
    ZERO,
    enhancedButtons,
    getButtons,
} from "@point_of_sale/app/generic_components/numpad/numpad";
import { NumberPopup } from "@point_of_sale/app/utils/input_popups/number_popup";
import { makeAwaitable } from "@point_of_sale/app/store/make_awaitable_dialog";
import {
    SPLIT_MODES,
    previewSplitPlan,
    roundPaymentAmount,
} from "@pos_payment_split/app/split_payment_math";

export class SplitPaymentDialog extends Component {
    static template = "pos_payment_split.SplitPaymentDialog";
    static components = { Dialog };
    static props = {
        close: Function,
        due: Number,
        currency: Object,
        formatCurrency: Function,
        paymentMethodName: String,
        confirmSplit: Function,
    };

    setup() {
        this.dialog = useService("dialog");
        this.numberBuffer = useService("number_buffer");
        this.state = useState({
            mode: SPLIT_MODES.FULL,
            value: "",
        });
    }

    get parsedValue() {
        const raw = String(this.state.value).replace(",", ".").trim();
        if (this.state.mode === SPLIT_MODES.PARTS) {
            const num = parseInt(raw, 10);
            return Number.isFinite(num) ? num : 0;
        }
        const num = parseFloat(raw);
        return Number.isFinite(num) ? num : 0;
    }

    get valueLabel() {
        return _t("Enter Below:");
    }

    get valuePlaceholder() {
        if (this.state.mode === SPLIT_MODES.PARTS) {
            return _t("Number of payments");
        }
        return _t("Amount");
    }

    get inputStep() {
        return this.state.mode === SPLIT_MODES.PARTS ? "1" : "0.01";
    }

    get inputMin() {
        return this.state.mode === SPLIT_MODES.PARTS ? "2" : "0";
    }

    get inputMax() {
        return this.state.mode === SPLIT_MODES.PARTS ? "20" : false;
    }

    get isValueValid() {
        if (this.state.mode === SPLIT_MODES.FULL) {
            return true;
        }
        const value = this.parsedValue;
        if (value <= 0) {
            return false;
        }
        if (this.state.mode === SPLIT_MODES.PARTS) {
            return value >= 2 && value <= 20 && Number.isInteger(value);
        }
        return true;
    }

    get validationMessage() {
        if (this.state.mode === SPLIT_MODES.FULL) {
            return "";
        }
        if (this.parsedValue <= 0) {
            return _t("Enter a value greater than zero.");
        }
        if (this.state.mode === SPLIT_MODES.PARTS) {
            if (this.parsedValue < 2 || this.parsedValue > 20) {
                return _t("Enter between 2 and 20 payments.");
            }
        }
        return "";
    }

    get preview() {
        if (this.state.mode === SPLIT_MODES.FULL || !this.isValueValid) {
            return null;
        }
        return previewSplitPlan(
            this.state.mode,
            this.parsedValue,
            this.props.due,
            this.props.currency
        );
    }

    get remainingLabel() {
        return this.props.formatCurrency(roundPaymentAmount(this.props.due, this.props.currency));
    }

    get title() {
        return _t("Payment option:");
    }

    get labelFull() {
        return _t("Full");
    }

    get labelPartial() {
        return _t("Partial");
    }

    get labelSplitBy() {
        return _t("Split By");
    }

    get labelCancel() {
        return _t("Cancel");
    }

    get labelSubmit() {
        return _t("Submit");
    }

    get labelOpenNumpad() {
        return _t("Open numpad");
    }

    get labelRemaining() {
        return _t("Order due");
    }

    get labelPayments() {
        return _t("Payments in plan");
    }

    get labelFirstCharge() {
        return _t("First charge");
    }

    get labelPerPart() {
        return _t("Per payment");
    }

    get labelRemainingAfter() {
        return _t("Due after this payment");
    }

    get labelChange() {
        return _t("Change");
    }

    get showInput() {
        return this.state.mode !== SPLIT_MODES.FULL;
    }

    get showRemainingAfter() {
        return (
            this.preview &&
            this.state.mode !== SPLIT_MODES.PARTS &&
            this.preview.remainingAfter > 0
        );
    }

    get showChange() {
        return (
            this.preview &&
            this.state.mode === SPLIT_MODES.AMOUNT &&
            this.preview.changeAmount > 0
        );
    }

    setMode(mode) {
        this.state.mode = mode;
        this.state.value = "";
    }

    onValueInput(ev) {
        this.state.value = ev.target.value;
    }

    _normalizeNumpadBuffer(buffer) {
        return String(buffer ?? "").replace(",", ".").trim();
    }

    _isNumpadBufferValid(buffer) {
        const raw = this._normalizeNumpadBuffer(buffer);
        if (!raw) {
            return false;
        }
        if (this.state.mode === SPLIT_MODES.PARTS) {
            const num = parseInt(raw, 10);
            return Number.isInteger(num) && num >= 2 && num <= 20;
        }
        const num = parseMonetary(raw);
        return Number.isFinite(num) && num > 0;
    }

    async openNumpad() {
        const isParts = this.state.mode === SPLIT_MODES.PARTS;
        const isAmount = this.state.mode === SPLIT_MODES.AMOUNT;
        this.numberBuffer.reset();

        const payload = await makeAwaitable(this.dialog, NumberPopup, {
            title: isParts ? _t("Number of payments") : _t("Amount"),
            placeholder: this.valuePlaceholder,
            buttons: isParts ? getButtons([ZERO, BACKSPACE]) : enhancedButtons(),
            startingValue: this.state.value || "",
            formatDisplayedValue: isAmount
                ? (value) => {
                      const raw = this._normalizeNumpadBuffer(value);
                      if (!raw) {
                          return "";
                      }
                      const num = parseMonetary(raw);
                      return Number.isFinite(num)
                          ? this.props.formatCurrency(num)
                          : raw;
                  }
                : (value) => value,
            isValid: (buffer) => this._isNumpadBufferValid(buffer),
            confirmButtonLabel: _t("Ok"),
        });

        this.numberBuffer.reset();
        if (payload === undefined) {
            return;
        }
        const normalized = this._normalizeNumpadBuffer(payload);
        if (normalized) {
            this.state.value = normalized;
        }
    }

    onCancel() {
        this.props.close();
    }

    onSubmit() {
        if (!this.isValueValid) {
            return;
        }
        this.props.confirmSplit({
            mode: this.state.mode,
            value: this.state.mode === SPLIT_MODES.FULL ? this.props.due : this.parsedValue,
        });
        this.props.close();
    }
}
