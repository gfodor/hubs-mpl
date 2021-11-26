// Brief overview of client authorization can be found in the wiki:
// https://github.com/mozilla/hubs/wiki/Hubs-authorization
export function showHoverEffect(el) {
  const isFrozen = el.sceneEl.is("frozen");
  const isPinned = el.components.pinnable && el.components.pinnable.data.pinned;
  const isSpawner = !!el.components["super-spawner"];
  const isEmojiSpawner = isSpawner && el.components["super-spawner"].data.template === "#interactable-emoji";
  const isEmoji = !!el.components.emoji;
  const canMove =
    (isEmoji || isEmojiSpawner
      ? window.APP.hubChannel.can("spawn_emoji")
      : window.APP.hubChannel.can("spawn_and_move_media")) &&
    (!isPinned || window.APP.hubChannel.can("pin_objects"));
  return (isSpawner || !isPinned || isFrozen) && canMove;
}

export function canMove(entity) {
  const isPinned = entity.components.pinnable && entity.components.pinnable.data.pinned;
  const networkedTemplate = entity && entity.components.networked && entity.components.networked.data.template;
  const isCamera = networkedTemplate === "#interactable-camera";
  const isPen = networkedTemplate === "#interactable-pen";
  const spawnerTemplate =
    entity && entity.components["super-spawner"] && entity.components["super-spawner"].data.template;
  const isEmojiSpawner = spawnerTemplate === "#interactable-emoji";
  const isEmoji = !!entity.components.emoji;
  const isHoldableButton = entity.components.tags && entity.components.tags.data.holdableButton;
  return (
    isHoldableButton ||
    ((isEmoji || isEmojiSpawner
      ? window.APP.hubChannel.can("spawn_emoji")
      : window.APP.hubChannel.can("spawn_and_move_media")) &&
      (!isPinned || window.APP.hubChannel.can("pin_objects")) &&
      (!isCamera || window.APP.hubChannel.can("spawn_camera")) &&
      (!isPen || window.APP.hubChannel.can("spawn_drawing")))
  );
}
