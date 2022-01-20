import React, { useState, useCallback } from "react";
import PropTypes from "prop-types";
import { Modal } from "../modal/Modal";
import { CloseButton } from "../input/CloseButton";
import { Button, CancelButton, CloseButton as CloseModalButton } from "../input/Button";
import { Column } from "../layout/Column";
import { TextAreaInputField } from "../input/TextAreaInputField";
import { FormattedMessage, useIntl } from "react-intl";

export function ReportModal({ onClose, onConfirm }) {
  const [description, setDescription] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const onClickConfirm = useCallback(
    () => {
      onConfirm(description);
      setSubmitted(true);
    },
    [onConfirm, description]
  );

  const intl = useIntl();

  return (
    <Modal
      title={<FormattedMessage id="report-modal.title" defaultMessage="Report Issue" />}
      beforeTitle={<CloseButton onClick={onClose} />}
    >
      <Column style={{ display: submitted ? "flex" : "none" }} padding center centerMd="both" grow>
        <p>
          <FormattedMessage
            id="report-modal.message"
            defaultMessage="Your report has been submitted."
            values={{ linebreak: <br /> }}
          />
        </p>
        <CloseModalButton onClick={onClose} />
      </Column>
      <Column style={{ display: !submitted ? "flex" : "none" }} padding center centerMd="both" grow>
        <TextAreaInputField
          label={<FormattedMessage id="close-room-modal.confirm-room-name-field" defaultMessage="Description" />}
          onChange={e => setDescription(e.target.value)}
          value={description}
          name="description"
          autoComplete="off"
          placeholder={intl.formatMessage({
            id: "report-popover.placeholder",
            defaultMessage: "Tell us what happened"
          })}
          minRows={3}
          fullWidth
        />
        <Button preset="accept" onClick={onClickConfirm} style={{ display: !submitted ? "block" : "none" }}>
          <FormattedMessage id="report-modal.confirm" defaultMessage="Submit Report" />
        </Button>
        <CancelButton onClick={onClose} />
      </Column>
    </Modal>
  );
}

ReportModal.propTypes = {
  onConfirm: PropTypes.func,
  onClose: PropTypes.func
};
