import React, { useState, useEffect } from "react";
import PropTypes from "prop-types";
import styles from "./PeopleSidebar.scss";
import classNames from "classnames";
import { Sidebar } from "../sidebar/Sidebar";
import { CloseButton } from "../input/CloseButton";
import { IconButton } from "../input/IconButton";
import { ReactComponent as StarIcon } from "../icons/Star.svg";
import { ReactComponent as DesktopIcon } from "../icons/Desktop.svg";
import { ReactComponent as DiscordIcon } from "../icons/Discord.svg";
import { ReactComponent as PhoneIcon } from "../icons/Phone.svg";
import { ReactComponent as VRIcon } from "../icons/VR.svg";
import { ReactComponent as VolumeOffIcon } from "../icons/VolumeOff.svg";
import { ReactComponent as VolumeHighIcon } from "../icons/VolumeHigh.svg";
import { ReactComponent as VolumeMutedIcon } from "../icons/VolumeMuted.svg";
import { List, ButtonListItem } from "../layout/List";
import { FormattedMessage, useIntl } from "react-intl";

function getDeviceLabel(ctx, intl) {
  if (ctx) {
    if (ctx.hmd) {
      return intl.formatMessage({ id: "people-sidebar.device-label.vr", defaultMessage: "VR" });
    } else if (ctx.discord) {
      return intl.formatMessage({ id: "people-sidebar.device-label.discord", defaultMessage: "Discord Bot" });
    } else if (ctx.mobile) {
      return intl.formatMessage({ id: "people-sidebar.device-label.mobile", defaultMessage: "Mobile" });
    }
  }

  return intl.formatMessage({ id: "people-sidebar.device-label.desktop", defaultMessage: "Desktop" });
}

function getDeviceIconComponent(ctx) {
  if (ctx) {
    if (ctx.hmd) {
      return VRIcon;
    } else if (ctx.discord) {
      return DiscordIcon;
    } else if (ctx.mobile) {
      return PhoneIcon;
    }
  }

  return DesktopIcon;
}

function getVoiceLabel(micPresence, intl) {
  if (micPresence) {
    if (micPresence.talking) {
      return intl.formatMessage({ id: "people-sidebar.voice-label.talking", defaultMessage: "Talking" });
    } else if (micPresence.muted) {
      return intl.formatMessage({ id: "people-sidebar.voice-label.muted", defaultMessage: "Muted" });
    }
  }

  return intl.formatMessage({ id: "people-sidebar.voice-label.not-talking", defaultMessage: "Not Talking" });
}

function getVoiceIconComponent(micPresence) {
  if (micPresence) {
    if (micPresence.muted) {
      return VolumeMutedIcon;
    } else if (micPresence.talking) {
      return VolumeHighIcon;
    }
  }

  return VolumeOffIcon;
}

function getPresenceMessage(presence, intl) {
  switch (presence) {
    case "lobby":
      return intl.formatMessage({ id: "people-sidebar.presence.in-lobby", defaultMessage: "In Lobby" });
    case "room":
      return intl.formatMessage({ id: "people-sidebar.presence.in-room", defaultMessage: "In Room" });
    case "entering":
      return intl.formatMessage({ id: "people-sidebar.presence.entering", defaultMessage: "Entering Room" });
    default:
      return undefined;
  }
}

function getPersonName(person, intl) {
  const you = intl.formatMessage({
    id: "people-sidebar.person-name.you",
    defaultMessage: "You"
  });

  return person.profile.displayName + (person.isMe ? ` (${you})` : "");
}

export function PeopleSidebar({ hubChannel, people, onSelectPerson, onClose, showMuteAll, onMuteAll }) {
  const intl = useIntl();
  const [isMutingAll, setIsMutingAll] = useState(hubChannel && hubChannel.isMutingAll);

  useEffect(
    () => {
      if (!hubChannel) return;

      const handler = () => {
        setIsMutingAll(hubChannel.isMutingAll);
      };

      hubChannel.addEventListener("mute_all_changed", handler);
      return () => hubChannel.removeEventListener("mute_all_changed", handler);
    },
    [hubChannel, setIsMutingAll]
  );

  return (
    <Sidebar
      title={
        <FormattedMessage
          id="people-sidebar.title"
          defaultMessage="People ({numPeople})"
          values={{ numPeople: people.length }}
        />
      }
      beforeTitle={<CloseButton onClick={onClose} />}
      afterTitle={
        showMuteAll ? (
          isMutingAll ? (
            <IconButton onClick={onMuteAll} className={classNames(styles.mutingAll, styles.muteAll)}>
              <FormattedMessage id="people-sidebar.muting-all-button" defaultMessage="Muting All" />
            </IconButton>
          ) : (
            <IconButton onClick={onMuteAll}>
              <FormattedMessage id="people-sidebar.mute-all-button" defaultMessage="Mute All" />
            </IconButton>
          )
        ) : (
          undefined
        )
      }
    >
      <List>
        {people.map(person => {
          const DeviceIcon = getDeviceIconComponent(person.context);
          const VoiceIcon = getVoiceIconComponent(person.micPresence);

          return (
            <ButtonListItem
              className={styles.person}
              key={person.id}
              type="button"
              onClick={e => onSelectPerson(person, e)}
            >
              {<DeviceIcon title={getDeviceLabel(person.context, intl)} />}
              {!person.context.discord && VoiceIcon && <VoiceIcon title={getVoiceLabel(person.micPresence, intl)} />}
              <p>{getPersonName(person, intl)}</p>
              {person.roles.owner && (
                <StarIcon
                  title={intl.formatMessage({ id: "people-sidebar.moderator-label", defaultMessage: "Moderator" })}
                  className={styles.moderatorIcon}
                  width={12}
                  height={12}
                />
              )}
              <p className={styles.presence}>{getPresenceMessage(person.presence, intl)}</p>
            </ButtonListItem>
          );
        })}
      </List>
    </Sidebar>
  );
}

PeopleSidebar.propTypes = {
  people: PropTypes.array,
  onSelectPerson: PropTypes.func,
  showMuteAll: PropTypes.bool,
  onMuteAll: PropTypes.func,
  onClose: PropTypes.func,
  hubChannel: PropTypes.object.isRequired
};

PeopleSidebar.defaultProps = {
  people: [],
  onSelectPerson: () => {}
};
