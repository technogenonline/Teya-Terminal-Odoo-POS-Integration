/** @odoo-module */
/* global Sha1 */

import { _t } from "@web/core/l10n/translation";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { NumberPopup } from "@point_of_sale/app/utils/input_popups/number_popup";
import { makeAwaitable } from "@point_of_sale/app/store/make_awaitable_dialog";

function getAuthorizedEmployeesWithPin(pos) {
    const employees = pos.models?.["hr.employee"];
    return employees
        ? employees.filter((employee) => employee._role === "manager" && employee._pin)
        : [];
}

/**
 * Require an advanced-rights / manager PIN (pos_hr) before terminal force done.
 * Any configured advanced employee PIN may be used, not only the logged-in cashier.
 * @returns {Promise<boolean>}
 */
export async function requireTerminalManagerApproval(pos, dialog) {
    if (!pos.config.module_pos_hr) {
        if (pos.get_cashier()?._role === "manager") {
            return true;
        }
        dialog.add(AlertDialog, {
            title: _t("Access denied"),
            body: _t("Only an employee with advanced rights can use this action."),
        });
        return false;
    }

    const authorizedEmployees = getAuthorizedEmployeesWithPin(pos);
    if (!authorizedEmployees.length) {
        dialog.add(AlertDialog, {
            title: _t("Access denied"),
            body: _t(
                "No advanced employee PIN is configured. Set a PIN on employees with advanced rights in HR, then try again."
            ),
        });
        return false;
    }

    while (true) {
        const pin = await makeAwaitable(dialog, NumberPopup, {
            formatDisplayedValue: (value) => value.replace(/./g, "•"),
            title: _t("Advanced rights PIN"),
        });
        if (!pin) {
            return false;
        }
        const hashed = Sha1.hash(pin);
        if (authorizedEmployees.some((employee) => employee._pin === hashed)) {
            return true;
        }
        const retry = await new Promise((resolve) => {
            dialog.add(AlertDialog, {
                title: _t("Wrong PIN"),
                body: _t("The PIN you entered is incorrect. Try again or cancel."),
                confirmLabel: _t("Try again"),
                cancelLabel: _t("Cancel"),
                confirm: () => resolve(true),
                cancel: () => resolve(false),
            });
        });
        if (!retry) {
            return false;
        }
    }
}
