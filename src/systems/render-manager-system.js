import { BatchManager } from "@mozillareality/three-batch-manager";

import HubsBatchRawUniformGroup from "./render-manager/hubs-batch-raw-uniform-group";
import { sizeofInstances } from "./render-manager/hubs-batch-raw-uniform-group";
import unlitBatchVert from "./render-manager/unlit-batch.vert";
import unlitBatchFrag from "./render-manager/unlit-batch.frag";
import qsTruthy from "../utils/qs_truthy";

const MAX_INSTANCES = 250;
const UBO_BYTE_LENGTH = sizeofInstances(MAX_INSTANCES);

export class BatchManagerSystem {
  constructor(scene, renderer) {
    this.meshToEl = new WeakMap();
    const gl = renderer.getContext();

    if (qsTruthy("disableBatching")) {
      console.warn("Batching disabled by user via disableBatching. Disabling batching.");
      return;
    }

    if (!(window.WebGL2RenderingContext && gl instanceof WebGL2RenderingContext)) {
      console.warn("Batching requires WebGL 2. Disabling batching.");
      return;
    }

    if (UBO_BYTE_LENGTH > gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE)) {
      console.warn("Insufficient MAX_UNIFORM_BLOCK_SIZE, Disabling batching.");
      return;
    }

    this.ubo = new HubsBatchRawUniformGroup(MAX_INSTANCES, this.meshToEl);
    this.batchManager = new BatchManager(scene, renderer, {
      maxInstances: MAX_INSTANCES,
      ubo: this.ubo,
      shaders: {
        unlit: {
          vertexShader: unlitBatchVert,
          fragmentShader: unlitBatchFrag
        }
      }
    });
  }

  addObject(rootObject) {
    let batchedCount = 0;
    rootObject.traverse(object => {
      if (object.isMesh) {
        const batchCount = this.batchManager.batches.length;

        if (this.batchManager.addMesh(object)) {
          batchedCount++;

          // OSTN hack
          if (this.batchManager.batches.length !== batchCount) {
            for (const batch of this.batchManager.batches) {
              batch.material.glslVersion = "300 es";
            }
          }
        }
      }
    });
    return batchedCount;
  }

  removeObject(rootObject) {
    rootObject.traverse(object => {
      if (object.isMesh) {
        this.batchManager.removeMesh(object);
      }
    });
  }

  tick(time) {
    this.batchManager.update(time);
  }
}
