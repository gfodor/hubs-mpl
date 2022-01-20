import React, { useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { ReportPopoverButton } from "./ReportPopover";
import { handleExitTo2DInterstitial } from "../../utils/vr-interstitial";

export function ReportPopoverContainer({ scene, ...rest }) {
  const popoverApiRef = useRef();

  // Handle clicking on the invite button while in VR.
  useEffect(
    () => {
      function onReportButtonClicked() {
        handleExitTo2DInterstitial(true, () => {}).then(() => {
          popoverApiRef.current.openPopover();
        });
      }

      scene.addEventListener("action_report", onReportButtonClicked);

      return () => {
        scene.removeEventListener("action_report", onReportButtonClicked);
      };
    },
    [scene, popoverApiRef]
  );

  return <ReportPopoverButton popoverApiRef={popoverApiRef} {...rest} />;
}

ReportPopoverContainer.propTypes = {
  scene: PropTypes.object.isRequired
};
