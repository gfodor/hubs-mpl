import { paths } from "./userinput/paths";
import { SOURCES } from "../storage/media-search-store";
import { getCurrentlyMirroredMedia } from "../utils/media-utils";

const MEDIA_SEARCH_PATHS = [
  paths.actions.mediaSearch1,
  paths.actions.mediaSearch2,
  paths.actions.mediaSearch3,
  paths.actions.mediaSearch4,
  paths.actions.mediaSearch5,
  paths.actions.mediaSearch6,
  paths.actions.mediaSearch7,
  paths.actions.mediaSearch8
];

// Every frame, looks for input paths that trigger UI-relevant events and handles them.
AFRAME.registerSystem("ui-hotkeys", {
  init() {
    this.mediaSearchStore = window.APP.mediaSearchStore;
  },

  tick: function() {
    if (!this.userinput) {
      this.userinput = this.el.systems.userinput;
    }

    if (this.userinput.get(paths.actions.focusChat)) {
      this.focusChat();
    }

    if (this.userinput.get(paths.actions.focusChatCommand)) {
      this.focusChat("/");
    }

    if (this.userinput.get(paths.actions.mediaExit)) {
      const state = window.APP.history.location.state && window.APP.history.location.state.value;
      const ignoredStates = new Set(["avatar-editor", "link", "profile", "device", "audio"]);
      const maybeInMediaBrowser = !state || !ignoredStates.has(state);
      if (maybeInMediaBrowser) {
        // Do not push "exit media browser" to history
        // if we know we are NOT in the media browser.
        // TODO: If we set the state to "media browser"
        //       while the media browser is open, then we
        //       can check that condition directly.
        //       Until then, we push "exit media browser"
        //       to the history if state is undefined.
        this.mediaSearchStore.pushExitMediaBrowserHistory();
      }

      this.el.emit("action_exit_watch");
    }

    for (let i = 0; i < MEDIA_SEARCH_PATHS.length; i++) {
      if (this.userinput.get(MEDIA_SEARCH_PATHS[i]) && window.APP.hubChannel.can("spawn_and_move_media")) {
        this.mediaSearchStore.sourceNavigate(SOURCES[i]);
      }
    }

    if (this.userinput.get(paths.actions.toggleCamera)) {
      this.el.emit("action_toggle_camera");
    }

    if (this.userinput.get(paths.actions.toggleUI)) {
      this.el.emit("action_toggle_ui");
    }

    const snapRotateLeft = this.userinput.get(paths.actions.snapRotateLeft);
    const snapRotateRight = this.userinput.get(paths.actions.snapRotateRight);
    const currentMirroredMedia = getCurrentlyMirroredMedia();

    if (currentMirroredMedia && (snapRotateLeft || snapRotateRight)) {
      const pager = currentMirroredMedia.components["media-pager"];

      if (pager) {
        (snapRotateLeft ? pager.onPrev : pager.onNext)();
      }
    }
  },

  focusChat: function(prefix) {
    const target = document.querySelector(".chat-focus-target");
    if (!target) return;

    target.focus();

    if (prefix) {
      target.value = prefix;
    }
  }
});
