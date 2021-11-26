import { setMatrixWorld, affixToWorldUp } from "../utils/three-utils";
import { WORLD_MATRIX_CONSUMERS } from "../utils/threejs-world-update";

const rotate = new THREE.Matrix4().makeRotationY(Math.PI);
const translate = new THREE.Matrix4().makeTranslation(0, -0.25, 0);
const m = new THREE.Matrix4();

AFRAME.registerComponent("inspect-pivot-offset-from-camera", {
  tick() {
    if (this.el.object3D.parent.consumeIfDirtyWorldMatrix(WORLD_MATRIX_CONSUMERS.AVATAR_INSPECT_PIVOTS)) {
      const parent = this.el.object3D.parent;
      parent.updateMatrices();
      setMatrixWorld(
        this.el.object3D,
        affixToWorldUp(parent.matrixWorld, m)
          .multiply(translate)
          .multiply(rotate)
      );
    }
  }
});
