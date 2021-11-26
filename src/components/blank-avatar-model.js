import blankAvatarGlb from "!!url-loader!../assets/models/blank-avatar.glb";

function ensureAvatarNodes(json) {
  const { nodes } = json;
  if (!nodes.some(node => node.name === "Head")) {
    // If the avatar model doesn't have a Head node. The user has probably chosen a custom GLB.
    // So, we need to construct a suitable hierarchy for avatar functionality to work.
    // We re-parent the original root node to the Head node and set the scene root to a new AvatarRoot.

    // Note: We assume that the first node in the primary scene is the one we care about.
    const originalRoot = json.scenes[json.scene].nodes[0];
    nodes.push({ name: "Head", children: [originalRoot] });
    nodes.push({ name: "AvatarRoot", children: [nodes.length - 1] });
    json.scenes[json.scene].nodes[0] = nodes.length - 1;
  }
  return json;
}

AFRAME.registerComponent("blank-avatar-model", {
  init() {
    this.el.components["gltf-model-plus"].jsonPreprocessor = ensureAvatarNodes;
    this.el.setAttribute("gltf-model-plus", "src", blankAvatarGlb);
  }
});
