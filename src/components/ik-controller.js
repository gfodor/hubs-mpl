import { waitForDOMContentLoaded } from "../utils/async-utils";
import { almostEqual, almostEqualQuaternion, almostEqualVec3 } from "../utils/three-utils";
const { Vector3, Quaternion, Matrix4, Euler } = THREE;

const BezierEasing = (function() {
  const NEWTON_ITERATIONS = 4;
  const NEWTON_MIN_SLOPE = 0.001;
  const SUBDIVISION_PRECISION = 0.0000001;
  const SUBDIVISION_MAX_ITERATIONS = 10;

  const kSplineTableSize = 11;
  const kSampleStepSize = 1.0 / (kSplineTableSize - 1.0);

  const float32ArraySupported = typeof Float32Array === "function";

  const A = (aA1, aA2) => {
    return 1.0 - 3.0 * aA2 + 3.0 * aA1;
  };
  const B = (aA1, aA2) => {
    return 3.0 * aA2 - 6.0 * aA1;
  };
  const C = aA1 => {
    return 3.0 * aA1;
  };

  const calcBezier = (aT, aA1, aA2) => {
    return ((A(aA1, aA2) * aT + B(aA1, aA2)) * aT + C(aA1)) * aT;
  };

  const getSlope = (aT, aA1, aA2) => {
    return 3.0 * A(aA1, aA2) * aT * aT + 2.0 * B(aA1, aA2) * aT + C(aA1);
  };

  const binarySubdivide = (aX, aA, aB, mX1, mX2) => {
    let currentX,
      currentT,
      i = 0;
    do {
      currentT = aA + (aB - aA) / 2.0;
      currentX = calcBezier(currentT, mX1, mX2) - aX;
      if (currentX > 0.0) {
        aB = currentT;
      } else {
        aA = currentT;
      }
    } while (Math.abs(currentX) > SUBDIVISION_PRECISION && ++i < SUBDIVISION_MAX_ITERATIONS);
    return currentT;
  };

  const newtonRaphsonIterate = (aX, aGuessT, mX1, mX2) => {
    for (let i = 0; i < NEWTON_ITERATIONS; ++i) {
      const currentSlope = getSlope(aGuessT, mX1, mX2);
      if (currentSlope === 0.0) {
        return aGuessT;
      }
      const currentX = calcBezier(aGuessT, mX1, mX2) - aX;
      aGuessT -= currentX / currentSlope;
    }
    return aGuessT;
  };

  const LinearEasing = x => {
    return x;
  };

  return (mX1, mY1, mX2, mY2) => {
    if (!(0 <= mX1 && mX1 <= 1 && 0 <= mX2 && mX2 <= 1)) {
      throw new Error("bezier x values must be in [0, 1] range");
    }

    if (mX1 === mY1 && mX2 === mY2) {
      return LinearEasing;
    }

    const sampleValues = float32ArraySupported ? new Float32Array(kSplineTableSize) : new Array(kSplineTableSize);
    for (let i = 0; i < kSplineTableSize; ++i) {
      sampleValues[i] = calcBezier(i * kSampleStepSize, mX1, mX2);
    }

    const getTForX = aX => {
      let intervalStart = 0.0;
      let currentSample = 1;
      const lastSample = kSplineTableSize - 1;

      for (; currentSample !== lastSample && sampleValues[currentSample] <= aX; ++currentSample) {
        intervalStart += kSampleStepSize;
      }
      --currentSample;

      const dist = (aX - sampleValues[currentSample]) / (sampleValues[currentSample + 1] - sampleValues[currentSample]);
      const guessForT = intervalStart + dist * kSampleStepSize;

      const initialSlope = getSlope(guessForT, mX1, mX2);
      if (initialSlope >= NEWTON_MIN_SLOPE) {
        return newtonRaphsonIterate(aX, guessForT, mX1, mX2);
      } else if (initialSlope === 0.0) {
        return guessForT;
      } else {
        return binarySubdivide(aX, intervalStart, intervalStart + kSampleStepSize, mX1, mX2);
      }
    };

    return x => {
      if (x === 0 || x === 1) {
        return x;
      }
      return calcBezier(getTForX(x), mY1, mY2);
    };
  };
})();

const squeezeSpringStep = BezierEasing(0.47, -0.07, 0.44, 1.65);
const jumpSpringStep = BezierEasing(0.47, 0.0, 0.44, 2.35);

const getAudioFeedbackScale = (() => {
  const tempScaleFromPosition = new THREE.Vector3();
  const tempScaleToPosition = new THREE.Vector3();

  return function(fromObject, toObject, minDistance, minScale, maxScale, volume) {
    tempScaleToPosition.setFromMatrixPosition(toObject.matrixWorld);
    tempScaleFromPosition.setFromMatrixPosition(fromObject.matrixWorld);
    const distance = tempScaleFromPosition.distanceTo(tempScaleToPosition);
    if (distance < minDistance) {
      return minScale;
    } else {
      return Math.min(maxScale, minScale + (maxScale - minScale) * volume * 8 * (distance / 5));
    }
  };
})();

function quaternionAlmostEquals(epsilon, u, v) {
  // Note: q and -q represent same rotation
  return (
    (Math.abs(u.x - v.x) < epsilon &&
      Math.abs(u.y - v.y) < epsilon &&
      Math.abs(u.z - v.z) < epsilon &&
      Math.abs(u.w - v.w) < epsilon) ||
    (Math.abs(-u.x - v.x) < epsilon &&
      Math.abs(-u.y - v.y) < epsilon &&
      Math.abs(-u.z - v.z) < epsilon &&
      Math.abs(-u.w - v.w) < epsilon)
  );
}

/**
 * Provides access to the end effectors for IK.
 * @namespace avatar
 * @component ik-root
 */
AFRAME.registerComponent("ik-root", {
  schema: {
    camera: { type: "string", default: ".camera" },
    leftController: { type: "string", default: ".left-controller" },
    rightController: { type: "string", default: ".right-controller" }
  },
  update(oldData) {
    if (this.data.camera !== oldData.camera) {
      this.camera = this.el.querySelector(this.data.camera);
    }

    if (this.data.leftController !== oldData.leftController) {
      this.leftController = this.el.querySelector(this.data.leftController);
    }

    if (this.data.rightController !== oldData.rightController) {
      this.rightController = this.el.querySelector(this.data.rightController);
    }
  }
});

function findIKRoot(entity) {
  while (entity && !(entity.components && entity.components["ik-root"])) {
    entity = entity.parentNode;
  }
  return entity && entity.components["ik-root"];
}

const HAND_ROTATIONS = {
  left: new Matrix4().makeRotationFromEuler(new Euler(-Math.PI / 2, Math.PI / 2, 0)),
  right: new Matrix4().makeRotationFromEuler(new Euler(-Math.PI / 2, -Math.PI / 2, 0))
};

const angleOnXZPlaneBetweenMatrixRotations = (function() {
  const XZ_PLANE_NORMAL = new THREE.Vector3(0, -1, 0);
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  return function angleOnXZPlaneBetweenMatrixRotations(matrixA, matrixB) {
    v1.setFromMatrixColumn(matrixA, 2).projectOnPlane(XZ_PLANE_NORMAL);
    v2.setFromMatrixColumn(matrixB, 2).projectOnPlane(XZ_PLANE_NORMAL);
    return v1.angleTo(v2);
  };
})();

/**
 * Performs IK on a hip-rooted skeleton to align the hip, head and hands with camera and controller inputs.
 * @namespace avatar
 * @component ik-controller
 */
AFRAME.registerComponent("ik-controller", {
  schema: {
    leftEye: { type: "string", default: "LeftEye" },
    rightEye: { type: "string", default: "RightEye" },
    head: { type: "string", default: "Head" },
    neck: { type: "string", default: "Neck" },
    leftHand: { type: "string", default: "LeftHand" },
    rightHand: { type: "string", default: "RightHand" },
    chest: { type: "string", default: "Spine" },
    rotationSpeed: { default: 8 },
    maxLerpAngle: { default: 90 * THREE.Math.DEG2RAD },
    alwaysUpdate: { type: "boolean", default: false },
    instanceHeads: { type: "boolean", default: false },
    isSelf: { type: "boolean", default: false }
  },

  init() {
    this._runScheduledWork = this._runScheduledWork.bind(this);
    this._updateIsInView = this._updateIsInView.bind(this);
    this.avatarSystem = this.el.sceneEl.systems["hubs-systems"].avatarSystem;
    this.headScale = new THREE.Vector3();
    this.head = null;
    this.chest = null;
    this.leftEye = null;
    this.rightEye = null;
    this.leftHand = null;
    this.rightHand = null;
    this.neck = null;

    if (this.data.instanceHeads) {
      NAF.utils.getNetworkedEntity(this.el).then(networkedEl => {
        const creatorId = NAF.utils.getCreator(networkedEl);
        this.creatorId = creatorId;
        this.avatarEntityId = networkedEl.id;
        this.avatarSystem.register(this.avatarEntityId, this.creatorId, this.data.isSelf);
        this.avatarSystem.setIkController(this.avatarEntityId, this.el);
      });
    }

    this.flipY = new Matrix4().makeRotationY(Math.PI);

    this.cameraForward = new Matrix4();
    this.headTransform = new Matrix4();
    this.hipsPosition = new Vector3();

    this.invHipsToHeadVector = new Vector3();

    this.middleEyeMatrix = new Matrix4();
    this.middleEyePosition = new Vector3();
    this.invMiddleEyeToHead = new Matrix4();

    this.cameraYRotation = new Euler();
    this.cameraYQuaternion = new Quaternion();

    this.invHipsQuaternion = new Quaternion();
    this.headQuaternion = new Quaternion();

    this.rootToChest = new Matrix4();
    this.invRootToChest = new Matrix4();

    this.ikRoot = findIKRoot(this.el);
    this.feedbackScaleSamples = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

    if (!NAF.utils.isMine(this.ikRoot.el)) {
      this.remoteNetworkedAvatar = this.ikRoot.el.components["networked-avatar"];
      this.scaleAudioFeedback = null;
    }

    this.relativeMotionProgress = 0.0;
    this.relativeMotionMaxMagnitude = 1;
    this.jumpMotionProgress = 0.0;

    this.isInView = true;
    this.hasConvergedHips = false;
    this.lastCameraTransform = new THREE.Matrix4();
    waitForDOMContentLoaded().then(() => {
      this.playerCamera = document.getElementById("viewing-camera").getObject3D("camera");
    });

    this.el.sceneEl.systems["frame-scheduler"].schedule(this._runScheduledWork, "ik");
    this.forceIkUpdate = true;
  },

  remove() {
    this.el.sceneEl.systems["frame-scheduler"].unschedule(this._runScheduledWork, "ik");

    if (this.data.instanceHeads) {
      this.avatarSystem.unregister(this.avatarEntityId);
    }
  },

  update(oldData) {
    this.avatar = this.el.object3D;

    if (this.data.leftEye !== oldData.leftEye) {
      this.leftEye = this.el.object3D.getObjectByName(this.data.leftEye) || null;
    }

    if (this.data.rightEye !== oldData.rightEye) {
      this.rightEye = this.el.object3D.getObjectByName(this.data.rightEye) || null;
    }

    if (this.data.head !== oldData.head) {
      this.head = this.el.object3D.getObjectByName(this.data.head) || null;
    }

    if (this.data.neck !== oldData.neck) {
      this.neck = this.el.object3D.getObjectByName(this.data.neck) || null;
    }

    if (this.data.leftHand !== oldData.leftHand) {
      this.leftHand = this.el.object3D.getObjectByName(this.data.leftHand) || null;
    }

    if (this.data.rightHand !== oldData.rightHand) {
      this.rightHand = this.el.object3D.getObjectByName(this.data.rightHand) || null;
    }

    if (this.data.chest !== oldData.chest) {
      this.chest = this.el.object3D.getObjectByName(this.data.chest) || null;
    }

    if (this.leftEye !== null && this.rightEye !== null) {
      // Set middleEye's position to be right in the middle of the left and right eyes.
      this.middleEyePosition.addVectors(this.leftEye.position, this.rightEye.position);
      this.middleEyePosition.divideScalar(2);
      this.middleEyeMatrix.makeTranslation(
        this.middleEyePosition.x,
        this.middleEyePosition.y,
        this.middleEyePosition.z
      );

      this.invMiddleEyeToHead = this.middleEyeMatrix.copy(this.middleEyeMatrix).invert();
    }

    if (this.chest !== null && this.head !== null && this.neck !== null) {
      this.invHipsToHeadVector
        .addVectors(this.chest.position, this.neck.position)
        .add(this.head.position)
        .negate();
    }
  },

  tick(time, dt) {
    if (!this.ikRoot) {
      return;
    }

    const root = this.ikRoot.el.object3D;
    root.updateMatrices();

    const { camera, leftController, rightController } = this.ikRoot;

    // Springy value that indicates the forward velocity of a remote avatar.
    // When a remote avatar is moving forward, we lean it forward and 'squish' it
    const SYSTEMS = AFRAME.scenes[0].systems["hubs-systems"];

    let relativeMotionSpring = 0;
    let relativeMotionValue = 0;
    let isJumping = false;
    let jumpMotionSpring = false;

    if (this.remoteNetworkedAvatar) {
      relativeMotionValue = this.remoteNetworkedAvatar.data.relative_motion;
      isJumping = this.remoteNetworkedAvatar.data.is_jumping;
    } else {
      relativeMotionValue = SYSTEMS.characterController.relativeMotionValue;
      isJumping = SYSTEMS.characterController.jumpYVelocity !== null && SYSTEMS.characterController.jumpYVelocity > 2.5;
    }

    if (relativeMotionValue !== 0) {
      const t = this.relativeMotionProgress;
      relativeMotionSpring = squeezeSpringStep(t);
      this.relativeMotionProgress = Math.min(1, this.relativeMotionProgress + dt * 0.003);
      this.relativeMotionMaxMagnitude = Math.max(this.relativeMotionMaxMagnitude, Math.abs(relativeMotionValue));
    } else {
      const t = 1.0 - this.relativeMotionProgress;
      relativeMotionSpring = 1.0 - squeezeSpringStep(t);
      this.relativeMotionProgress = Math.max(0, this.relativeMotionProgress - dt * 0.003);

      if (this.relativeMotionProgress === 0) {
        this.relativeMotionMaxMagnitude = 0;
      }
    }

    if (isJumping) {
      const t = this.jumpMotionProgress;
      jumpMotionSpring = jumpSpringStep(t);
      this.jumpMotionProgress = Math.min(1, this.jumpMotionProgress + dt * 0.007);
    } else {
      const t = 1.0 - this.jumpMotionProgress;
      jumpMotionSpring = 1.0 - jumpSpringStep(t);
      this.jumpMotionProgress = Math.max(0, this.jumpMotionProgress - dt * 0.004);
    }

    camera.object3D.updateMatrices();

    const hasNewCameraTransform = !this.lastCameraTransform.equals(camera.object3D.matrix);
    const avatarAudioTrackSystem = SYSTEMS.avatarAudioTrackSystem;

    // Optimization: if the camera hasn't moved and the hips converged to the target orientation on a previous frame,
    // then the avatar does not need any IK this frame.
    //
    // Update in-view avatars every frame, and update out-of-view avatars via frame scheduler.
    if (
      this.data.alwaysUpdate ||
      avatarAudioTrackSystem.isSessionIdLive(this.creatorId) ||
      this.forceIkUpdate ||
      (this.isInView && (hasNewCameraTransform || !this.hasConvergedHips))
    ) {
      if (hasNewCameraTransform) {
        this.lastCameraTransform.copy(camera.object3D.matrix);
      }

      // Avoid expensive body lerping if no hands, since we don't show body etc without hands.
      const hasHands =
        this.leftHand && this.rightHand && leftController.object3D.visible && rightController.object3D.visible;

      const {
        avatar,
        head,
        neck,
        chest,
        cameraForward,
        headTransform,
        invMiddleEyeToHead,
        invHipsToHeadVector,
        flipY,
        cameraYRotation,
        cameraYQuaternion,
        invHipsQuaternion,
        rootToChest,
        invRootToChest
      } = this;

      // Camera faces the -Z direction. Flip it along the Y axis so that it is +Z.
      cameraForward.multiplyMatrices(camera.object3D.matrix, flipY);

      // Compute the head position such that the hmd position would be in line with the middleEye
      headTransform.multiplyMatrices(cameraForward, invMiddleEyeToHead);

      // Then position the avatar such that the head is aligned with headTransform
      // (which positions middleEye in line with the hmd)
      //
      // Note that we position the avatar itself, *not* the hips, since positioning the
      // hips will use vertex skinning to do the root displacement, which results in
      // frustum culling errors since three.js does not take into account skinning when
      // computing frustum culling sphere bounds.
      const avatarX = headTransform.elements[12] + invHipsToHeadVector.x;
      const avatarY = headTransform.elements[13] + invHipsToHeadVector.y;
      const avatarZ = headTransform.elements[14] + invHipsToHeadVector.z;

      if (
        !almostEqual(avatarX, avatar.position.x) ||
        !almostEqual(avatarY, avatar.position.y) ||
        !almostEqual(avatarZ, avatar.position.z)
      ) {
        avatar.position.x = avatarX;
        avatar.position.y = avatarY;
        avatar.position.z = avatarZ;
        avatar.matrixNeedsUpdate = true;
      }

      if (hasHands) {
        // Animate the hip rotation to follow the Y rotation of the camera with some damping.
        cameraYRotation.setFromRotationMatrix(cameraForward, "YXZ");
        cameraYRotation.x = 0;
        cameraYRotation.z = 0;
        cameraYQuaternion.setFromEuler(cameraYRotation);

        if (this._hadFirstTick) {
          camera.object3D.updateMatrices();
          avatar.updateMatrices();
          // Note: Camera faces down -Z, avatar faces down +Z
          const yDelta =
            Math.PI - angleOnXZPlaneBetweenMatrixRotations(camera.object3D.matrixWorld, avatar.matrixWorld);

          if (yDelta > this.data.maxLerpAngle) {
            avatar.quaternion.copy(cameraYQuaternion);
          } else {
            avatar.quaternion.slerp(cameraYQuaternion, (this.data.rotationSpeed * dt) / 1000);
          }
        } else {
          avatar.quaternion.copy(cameraYQuaternion);
        }

        this.hasConvergedHips = quaternionAlmostEquals(0.0001, cameraYQuaternion, avatar.quaternion);

        // Take the head orientation computed from the hmd, remove the Y rotation already applied to it by the hips,
        // and apply it to the head
        invHipsQuaternion.copy(avatar.quaternion).inverse();
        head.quaternion.setFromRotationMatrix(headTransform).premultiply(invHipsQuaternion);

        avatar.updateMatrices();
        rootToChest.multiplyMatrices(avatar.matrix, chest.matrix);
        invRootToChest.copy(rootToChest).invert();

        root.matrixNeedsUpdate = true;
        neck.matrixNeedsUpdate = true;
        head.matrixNeedsUpdate = true;
        chest.matrixNeedsUpdate = true;
      } else {
        this.hasConvergedHips = true;
        this.headQuaternion.setFromRotationMatrix(headTransform);

        if (!almostEqualQuaternion(this.headQuaternion, head.quaternion)) {
          head.quaternion.copy(this.headQuaternion);
          head.matrixNeedsUpdate = true;
        }
      }

      // Perform audio scale, head velocity squish + rotate on other avatars
      if (!this.data.isSelf) {
        let volume = 0;

        if (this.playerCamera && this.creatorId) {
          const minScale = 1;
          const maxScale = 1.125;
          const minDistance = 0.1;

          volume = avatarAudioTrackSystem.getVolumeForSessionId(this.creatorId);

          // Set here, but updated in ik-controller since we also scale head there.
          this.feedbackScaleSamples.push(
            getAudioFeedbackScale(head, this.playerCamera, minDistance, minScale, maxScale, volume)
          );
          this.feedbackScaleSamples.shift();
        }

        let feedbackScale = 0.0;
        for (let j = 0; j < this.feedbackScaleSamples.length; j++) {
          feedbackScale += this.feedbackScaleSamples[j];
        }

        feedbackScale /= this.feedbackScaleSamples.length;

        this.avatarSystem.setAvatarVolume(this.avatarEntityId, volume);

        if (relativeMotionSpring !== 0) {
          const scaleDXZ = 1.0 + relativeMotionSpring * 0.1 * this.relativeMotionMaxMagnitude;
          const scaleDY = 1.0 - relativeMotionSpring * 0.1 * this.relativeMotionMaxMagnitude;
          this.headScale.set(scaleDXZ * feedbackScale, scaleDY * feedbackScale, scaleDXZ * feedbackScale);
        } else if (jumpMotionSpring !== 0) {
          const scaleDXZ = 1.0 - jumpMotionSpring * 0.15;
          const scaleDY = 1.0 + jumpMotionSpring * 0.15;
          this.headScale.set(scaleDXZ * feedbackScale, scaleDY * feedbackScale, scaleDXZ * feedbackScale);
        } else {
          this.headScale.set(feedbackScale, feedbackScale, feedbackScale);
        }

        if (!almostEqualVec3(head.scale, this.headScale)) {
          head.scale.copy(this.headScale);
          head.matrixNeedsUpdate = true;
        }
      } else {
        if (relativeMotionSpring !== 0) {
          const scaleDXZ = 1.0 + relativeMotionSpring * 0.1 * this.relativeMotionMaxMagnitude;
          const scaleDY = 1.0 - relativeMotionSpring * 0.1 * this.relativeMotionMaxMagnitude;
          this.headScale.set(scaleDXZ, scaleDY, scaleDXZ);
        } else if (jumpMotionSpring !== 0) {
          const scaleDXZ = 1.0 - jumpMotionSpring * 0.15;
          const scaleDY = 1.0 + jumpMotionSpring * 0.15;
          this.headScale.set(scaleDXZ, scaleDY, scaleDXZ);
        } else {
          this.headScale.set(1.0, 1.0, 1.0);
        }
      }
    }

    const { leftHand, rightHand } = this;

    if (leftHand) this.updateHand(HAND_ROTATIONS.left, leftHand, leftController.object3D, true, this.isInView);
    if (rightHand) this.updateHand(HAND_ROTATIONS.right, rightHand, rightController.object3D, false, this.isInView);
    this.forceIkUpdate = false;

    if (!this._hadFirstTick) {
      // Ensure the avatar is not shown until we've done our first IK step, to prevent seeing mis-oriented/t-pose pose or our own avatar at the wrong place.
      this.ikRoot.el.object3D.visible = true;
      this._hadFirstTick = true;
    }
  },

  updateHand(handRotation, handObject3D, controllerObject3D, isLeft, isInView) {
    const handMatrix = handObject3D.matrix;

    // TODO: This coupling with personal-space-invader is not ideal.
    // There should be some intermediate thing managing multiple opinions about object visibility
    const spaceInvader = handObject3D.el.components["personal-space-invader"];

    if (spaceInvader) {
      // If this hand has an invader, defer to it to manage visibility overall but tell it to hide based upon controller state
      spaceInvader.setAlwaysHidden(!controllerObject3D.visible);
    } else {
      handObject3D.visible = controllerObject3D.visible;
    }

    // Optimization: skip IK update if not in view and not forced by frame scheduler
    if (controllerObject3D.visible && (isInView || this.forceIkUpdate || this.data.alwaysUpdate)) {
      handMatrix.multiplyMatrices(this.invRootToChest, controllerObject3D.matrix);

      handMatrix.multiply(handRotation);

      handObject3D.position.setFromMatrixPosition(handMatrix);
      handObject3D.rotation.setFromRotationMatrix(handMatrix);
      handObject3D.matrixNeedsUpdate = true;
    }
  },

  _runScheduledWork() {
    // Every scheduled run, we force an IK update on the next frame (so at most one avatar with forced IK per frame)
    // and also update the this.isInView bit on the avatar which is used to determine if an IK update should be run
    // every frame.
    this.forceIkUpdate = true;

    this._updateIsInView();
  },

  _updateIsInView: (function() {
    const frustum = new THREE.Frustum();
    const frustumMatrix = new THREE.Matrix4();
    const cameraWorld = new THREE.Vector3();
    const isInViewOfCamera = (screenCamera, pos) => {
      frustumMatrix.multiplyMatrices(screenCamera.projectionMatrix, screenCamera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(frustumMatrix);
      return frustum.containsPoint(pos);
    };

    return function() {
      if (!this.playerCamera || !this.ikRoot || !this.ikRoot.camera) return;

      const camera = this.ikRoot.camera.object3D;
      camera.getWorldPosition(cameraWorld);

      // Check player camera
      this.isInView = isInViewOfCamera(this.playerCamera, cameraWorld);

      if (!this.isInView) {
        // Check in-game camera if rendering to viewfinder and owned
        const cameraTools = this.el.sceneEl.systems["camera-tools"];

        if (cameraTools) {
          cameraTools.ifMyCameraRenderingViewfinder(cameraTool => {
            this.isInView = this.isInView || isInViewOfCamera(cameraTool.camera, cameraWorld);
          });
        }
      }
    };
  })()
});
