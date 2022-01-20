import React from "react";
import PropTypes from "prop-types";
import { Popover } from "../popover/Popover";
import { ToolbarButton } from "../input/ToolbarButton";
import { ReactComponent as ReportIcon } from "../icons/Document.svg";
import { defineMessage, useIntl } from "react-intl";

const reportPopoverTitle = defineMessage({
  id: "report-popover.title",
  defaultMessage: "Feedback"
});

export function ReportPopoverButton({ popoverApiRef, ...rest }) {
  const intl = useIntl();
  const title = intl.formatMessage(reportPopoverTitle);

  return (
    <Popover title={title} placement="top-start" offsetDistance={28} popoverApiRef={popoverApiRef}>
      {({ togglePopover, popoverVisible, triggerRef }) => (
        <ToolbarButton
          ref={triggerRef}
          selected={popoverVisible}
          icon={<ReportIcon />}
          onClick={togglePopover}
          label={title}
          {...rest}
        />
      )}
    </Popover>
  );
}

ReportPopoverButton.propTypes = {
  initiallyVisible: PropTypes.bool,
  popoverApiRef: PropTypes.object
};
