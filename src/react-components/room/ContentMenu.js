import React, { useState, useEffect } from "react";
import className from "classnames";
import { changeHub } from "../../change-hub";
import PropTypes from "prop-types";
import { joinChildren } from "../misc/joinChildren";
import styles from "./ContentMenu.scss";
import { ReactComponent as ObjectsIcon } from "../icons/Objects.svg";
import { ReactComponent as PeopleIcon } from "../icons/People.svg";
import { FormattedMessage } from "react-intl";

export function ContentMenuButton({ active, children, ...props }) {
  return (
    <button className={className(styles.contentMenuButton, { [styles.active]: active })} {...props}>
      {children}
    </button>
  );
}

ContentMenuButton.propTypes = {
  children: PropTypes.node,
  active: PropTypes.bool
};

export function ObjectsMenuButton(props) {
  return (
    <ContentMenuButton {...props}>
      <ObjectsIcon />
      <span>
        <FormattedMessage id="content-menu.objects-menu-button" defaultMessage="Objects" />
      </span>
    </ContentMenuButton>
  );
}

export function PeopleMenuButton(props) {
  const contentMenuButtonProps = { ...props };
  delete contentMenuButtonProps.presenceCount;

  return (
    <ContentMenuButton {...contentMenuButtonProps}>
      <PeopleIcon />
      <span>
        <FormattedMessage id="content-menu.people-menu-button" defaultMessage="People">
          ({props.presenceCount})
        </FormattedMessage>
      </span>
    </ContentMenuButton>
  );
}
PeopleMenuButton.propTypes = {
  presenceCount: PropTypes.number
};

export function RoomButton(props) {
  const contentMenuButtonProps = { ...props };
  delete contentMenuButtonProps.presenceCount;

  const [active, setIsActive] = useState(window.APP.hubChannel && window.APP.hubChannel.hubId === props.hubId);

  useEffect(
    () => {
      const handler = () => {
        setIsActive(window.APP.hubChannel && window.APP.hubChannel.hubId === props.hubId);
      };

      if (!window.APP.hubChannel) return;

      window.APP.hubChannel.addEventListener("hub_changed", handler);
      return () => window.APP.hubChannel.removeEventListener("hub_changed", handler);
    },
    [props.hubId]
  );

  return (
    <ContentMenuButton
      active={active}
      onClick={() => {
        if (window.APP.hubChannel.hubId !== props.hubId) {
          changeHub(props.hubId);
        }
      }}
      {...contentMenuButtonProps}
    >
      <div style={{ display: "flex", flexWrap: "nowrap" }}>
        <div>{props.hubName}</div>
        <span style={{ fontWeight: "bold" }} className="room-button-count" data-hub-id={props.hubId}>
          0
        </span>
      </div>
    </ContentMenuButton>
  );
}

RoomButton.propTypes = {
  hubName: PropTypes.string,
  hubId: PropTypes.string
};

export function ContentMenu({ children }) {
  return <div className={styles.contentMenu}>{joinChildren(children, () => <div className={styles.separator} />)}</div>;
}

export function RoomMenu({ children }) {
  return <div className={styles.roomMenu}>{joinChildren(children, () => <div className={styles.separator} />)}</div>;
}

ContentMenu.propTypes = {
  children: PropTypes.node
};

RoomMenu.propTypes = {
  children: PropTypes.node
};
