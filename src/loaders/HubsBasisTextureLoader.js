/* eslint-disable */

import transcoderWasmFile from "./basis_transcoder.wasm";
import BasisWorker from "./basis_transcoder.worker.js";

/**
 * @author Don McCurdy / https://www.donmccurdy.com
 * @author Austin Eng / https://github.com/austinEng
 * @author Shrek Shao / https://github.com/shrekshao
 */

/**
 * Loader for Basis Universal GPU Texture Codec.
 *
 * Basis Universal is a "supercompressed" GPU texture and texture video
 * compression system that outputs a highly compressed intermediate file format
 * (.basis) that can be quickly transcoded to a wide variety of GPU texture
 * compression formats.
 *
 * This loader parallelizes the transcoding process across a configurable number
 * of web workers, before transferring the transcoded compressed texture back
 * to the main thread.
 */

export default class HubsBasisTextureLoader extends THREE.Loader {
  constructor(manager, retainImages = false) {
    super(manager);

    this.retainImages = retainImages;
    this.transcoderPath = "";
    this.transcoderBinary = null;
    this.transcoderPending = null;

    this.workerLimit = 4;
    this.workerPool = [];
    this.workerNextTaskID = 1;
    this.workerConfig = {
      format: null,
      astcSupported: false,
      etcSupported: false,
      dxtSupported: false,
      pvrtcSupported: false,
      returnBuffer: false
    };
  }

  setTranscoderPath(path) {
    this.transcoderPath = path;

    return this;
  }

  setWorkerLimit(workerLimit) {
    this.workerLimit = workerLimit;

    return this;
  }

  detectSupport(renderer) {
    var config = this.workerConfig;

    config.astcSupported = !!renderer.extensions.get("WEBGL_compressed_texture_astc");
    config.etcSupported = !!renderer.extensions.get("WEBGL_compressed_texture_etc1");
    config.dxtSupported = !!renderer.extensions.get("WEBGL_compressed_texture_s3tc");
    config.pvrtcSupported =
      !!renderer.extensions.get("WEBGL_compressed_texture_pvrtc") ||
      !!renderer.extensions.get("WEBKIT_WEBGL_compressed_texture_pvrtc");

    if (config.astcSupported) {
      config.format = THREE.BasisTextureLoader.BASIS_FORMAT.cTFASTC_4x4;
    } else if (config.dxtSupported) {
      config.format = THREE.BasisTextureLoader.BASIS_FORMAT.cTFBC3;
    } else if (config.pvrtcSupported) {
      config.format = THREE.BasisTextureLoader.BASIS_FORMAT.cTFPVRTC1_4_RGBA;
    } else if (config.etcSupported) {
      config.format = THREE.BasisTextureLoader.BASIS_FORMAT.cTFETC1;
    } else {
      throw new Error("THREE.BasisTextureLoader: No suitable compressed texture format found.");
    }

    return this;
  }

  load(url, onLoad, onProgress, onError) {
    var loader = new THREE.FileLoader(this.manager);

    if (!this.ranDetect) {
      this.detectSupport(AFRAME.scenes[0].renderer);
      this.ranDetect = true;
    }

    loader.setResponseType("arraybuffer");

    loader.load(
      url,
      buffer => {
        this._createTexture(buffer)
          .then((texture, textureInfo) => {
            if (!this.retainImages) {
              texture.onUpdate = function() {
                if (!this.retainImages) {
                  // Delete texture data once it has been uploaded to the GPU
                  texture.mipmaps.length = 0;
                }
              };
            }

            onLoad(texture, textureInfo);
          })
          .catch(onError);
      },
      onProgress,
      onError
    );
  }

  /**
   * @param  {ArrayBuffer} buffer
   * @return {Promise<THREE.CompressedTexture>}
   */
  _createTexture(buffer) {
    var worker;
    var taskID;

    var texturePending = this._getWorker()
      .then(_worker => {
        worker = _worker;
        taskID = this.workerNextTaskID++;

        return new Promise((resolve, reject) => {
          worker._callbacks[taskID] = { resolve, reject };
          worker._taskCosts[taskID] = buffer.byteLength;
          worker._taskLoad += worker._taskCosts[taskID];

          worker.postMessage({ type: "transcode", id: taskID, buffer }, [buffer]);
        });
      })
      .then(message => {
        var config = this.workerConfig;

        var { width, height, mipmaps, format, hasAlpha, buffer } = message;

        var texture;
        var textureInfo = { width, height, hasAlpha };

        switch (format) {
          case THREE.BasisTextureLoader.BASIS_FORMAT.cTFASTC_4x4:
            texture = new THREE.CompressedTexture(mipmaps, width, height, THREE.RGBA_ASTC_4x4_Format);
            break;
          case THREE.BasisTextureLoader.BASIS_FORMAT.cTFBC1:
          case THREE.BasisTextureLoader.BASIS_FORMAT.cTFBC3:
            texture = new THREE.CompressedTexture(
              mipmaps,
              width,
              height,
              THREE.BasisTextureLoader.DXT_FORMAT_MAP[config.format],
              THREE.UnsignedByteType
            );
            break;
          case THREE.BasisTextureLoader.BASIS_FORMAT.cTFETC1:
            texture = new THREE.CompressedTexture(mipmaps, width, height, THREE.RGB_ETC1_Format);
            break;
          case THREE.BasisTextureLoader.BASIS_FORMAT.cTFPVRTC1_4_RGB:
            texture = new THREE.CompressedTexture(mipmaps, width, height, THREE.RGB_PVRTC_4BPPV1_Format);
            break;
          case THREE.BasisTextureLoader.BASIS_FORMAT.cTFPVRTC1_4_RGBA:
            texture = new THREE.CompressedTexture(mipmaps, width, height, THREE.RGBA_PVRTC_4BPPV1_Format);
            break;
          default:
            throw new Error("THREE.BasisTextureLoader: No supported format available.");
        }

        texture.minFilter = mipmaps.length === 1 ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

        texture.image.hasAlpha = hasAlpha;
        if (this.workerConfig.returnBuffer) {
          texture.image.data = buffer;
        }

        return texture;
      });

    texturePending.finally(() => {
      if (worker && taskID) {
        worker._taskLoad -= worker._taskCosts[taskID];
        delete worker._callbacks[taskID];
        delete worker._taskCosts[taskID];
      }
    });

    return texturePending;
  }

  _initTranscoder() {
    if (!this.transcoderBinary) {
      // Load transcoder WASM binary.
      var binaryLoader = new THREE.FileLoader(this.manager);
      binaryLoader.setPath(this.transcoderPath);
      binaryLoader.setResponseType("arraybuffer");
      var binaryContent = new Promise((resolve, reject) => {
        binaryLoader.load(transcoderWasmFile, resolve, undefined, reject);
      });

      this.transcoderPending = binaryContent.then(binaryContent => {
        this.transcoderBinary = binaryContent;
      });
    }

    return this.transcoderPending;
  }

  _getWorker() {
    return this._initTranscoder().then(() => {
      if (this.workerPool.length < this.workerLimit) {
        var worker = new BasisWorker();

        worker._callbacks = {};
        worker._taskCosts = {};
        worker._taskLoad = 0;

        worker.postMessage({
          type: "init",
          config: this.workerConfig,
          transcoderBinary: this.transcoderBinary
        });

        worker.onmessage = function(e) {
          var message = e.data;

          switch (message.type) {
            case "transcode":
              worker._callbacks[message.id].resolve(message);
              break;

            case "error":
              worker._callbacks[message.id].reject(message);
              break;

            default:
              console.error('THREE.BasisTextureLoader: Unexpected message, "' + message.type + '"');
          }
        };

        this.workerPool.push(worker);
      } else {
        this.workerPool.sort(function(a, b) {
          return a._taskLoad > b._taskLoad ? -1 : 1;
        });
      }

      return this.workerPool[this.workerPool.length - 1];
    });
  }

  dispose() {
    for (var i = 0; i < this.workerPool.length; i++) {
      this.workerPool[i].terminate();
    }

    this.workerPool.length = 0;

    return this;
  }
}

/* CONSTANTS */
THREE.BasisTextureLoader = {};

THREE.BasisTextureLoader.BASIS_FORMAT = {
  cTFETC1: 0,
  cTFETC2: 1,
  cTFBC1: 2,
  cTFBC3: 3,
  cTFBC4: 4,
  cTFBC5: 5,
  cTFBC7_M6_OPAQUE_ONLY: 6,
  cTFBC7_M5: 7,
  cTFPVRTC1_4_RGB: 8,
  cTFPVRTC1_4_RGBA: 9,
  cTFASTC_4x4: 10,
  cTFATC_RGB: 11,
  cTFATC_RGBA_INTERPOLATED_ALPHA: 12,
  cTFRGBA32: 13,
  cTFRGB565: 14,
  cTFBGR565: 15,
  cTFRGBA4444: 16
};

// DXT formats, from:
// http://www.khronos.org/registry/webgl/extensions/WEBGL_compressed_texture_s3tc/
THREE.BasisTextureLoader.DXT_FORMAT = {
  COMPRESSED_RGB_S3TC_DXT1_EXT: 0x83f0,
  COMPRESSED_RGBA_S3TC_DXT1_EXT: 0x83f1,
  COMPRESSED_RGBA_S3TC_DXT3_EXT: 0x83f2,
  COMPRESSED_RGBA_S3TC_DXT5_EXT: 0x83f3
};
THREE.BasisTextureLoader.DXT_FORMAT_MAP = {};
THREE.BasisTextureLoader.DXT_FORMAT_MAP[THREE.BasisTextureLoader.BASIS_FORMAT.cTFBC1] =
  THREE.BasisTextureLoader.DXT_FORMAT.COMPRESSED_RGB_S3TC_DXT1_EXT;
THREE.BasisTextureLoader.DXT_FORMAT_MAP[THREE.BasisTextureLoader.BASIS_FORMAT.cTFBC3] =
  THREE.BasisTextureLoader.DXT_FORMAT.COMPRESSED_RGBA_S3TC_DXT5_EXT;
