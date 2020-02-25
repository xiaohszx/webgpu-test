// Copyright 2020 Brandon Jones
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { GltfRenderer } from '../gltf-renderer.js';
import { PBRShaderModule } from './pbr-material.js';
import { vec2, vec3, vec4, mat4 } from '../third-party/gl-matrix/src/gl-matrix.js';

const SAMPLE_COUNT = 1;
const DEPTH_FORMAT = "depth24plus";

const ATTRIB_MAP = {
  POSITION: 0,
  NORMAL: 1,
  TANGENT: 2,
  TEXCOORD_0: 3,
  COLOR_0: 4,
};

// Only used for comparing values from glTF, which uses WebGL enums natively.
const GL = WebGLRenderingContext;

export class WebGPURenderer extends GltfRenderer {
  constructor() {
    super();

    this.context = this.canvas.getContext('gpupresent');

    this.frameUniforms = new Float32Array(16 + 16 + 4 + 4 + 4);

    this.projectionMatrix = new Float32Array(this.frameUniforms.buffer, 0, 16);
    this.viewMatrix = new Float32Array(this.frameUniforms.buffer, 16 * 4, 16);
    this.cameraPosition = new Float32Array(this.frameUniforms.buffer, 32 * 4, 3);
    this.lightDirection = new Float32Array(this.frameUniforms.buffer, 36 * 4, 3);
    this.lightColor = new Float32Array(this.frameUniforms.buffer, 40 * 4, 3);

    vec3.set(this.lightDirection, -0.5, -1.0, -0.25);
    vec3.set(this.lightColor, 0.6, 0.6, 0.5);

    this.pipelines = new Map(); // Map<String -> GPURenderPipeline>
    this.pipelineMaterials = new WeakMap(); // WeakMap<GPURenderPipeline, Map<Material, Primitive[]>>
  }

  async init() {
    this.adapter = await navigator.gpu.requestAdapter();
    this.device = await this.adapter.requestDevice();
    this.swapChainFormat = await this.context.getSwapChainPreferredFormat(this.device);
    this.swapChain = this.context.configureSwapChain({
      device: this.device,
      format: this.swapChainFormat
    });

    this.colorAttachment = {
      // attachment is acquired and set in onResize.
      attachment: undefined,
      // attachment is acquired and set in onFrame.
      resolveTarget: undefined,
      loadValue: { r: 0.0, g: 0.0, b: 0.5, a: 1.0 },
    };

    this.depthAttachment = {
      // attachment is acquired and set in onResize.
      attachment: undefined,
      depthLoadValue: 1.0,
      depthStoreOp: 'store',
      stencilLoadValue: 0,
      stencilStoreOp: 'store',
    };

    this.renderPassDescriptor = {
      colorAttachments: [this.colorAttachment],
      depthStencilAttachment: this.depthAttachment
    };

    this.frameUniformsBindGroupLayout = this.device.createBindGroupLayout({
      bindings: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        type: 'uniform-buffer'
      }]
    });

    this.materialUniformsBindGroupLayout = this.device.createBindGroupLayout({
      bindings: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        type: 'uniform-buffer'
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        type: 'sampled-texture'
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        type: 'sampler'
      }]
    });

    this.primitiveUniformsBindGroupLayout = this.device.createBindGroupLayout({
      bindings: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        type: 'uniform-buffer'
      }]
    });

    this.pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [
        this.frameUniformsBindGroupLayout, // set 0
        this.materialUniformsBindGroupLayout, // set 1
        this.primitiveUniformsBindGroupLayout // set 2
      ]
    });

    this.frameUniformsBuffer = this.device.createBuffer({
      size: this.frameUniforms.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.frameUniformBindGroup = this.device.createBindGroup({
      layout: this.frameUniformsBindGroupLayout,
      bindings: [{
        binding: 0, // FrameUniforms
        resource: {
          buffer: this.frameUniformsBuffer,
        },
      }],
    });

    // TODO: Will probably need to be per-material later
    await PBRShaderModule.initGlslang();
    this.pbrShaderModule = new PBRShaderModule(this.device);
  }

  onResize(width, height) {
    if (!this.device) return;

    const msaaColorTexture = this.device.createTexture({
      size: { width, height, depth: 1 },
      sampleCount: SAMPLE_COUNT,
      format: this.swapChainFormat,
      usage: GPUTextureUsage.OUTPUT_ATTACHMENT,
    });
    this.colorAttachment.attachment = msaaColorTexture.createView();

    const depthTexture = this.device.createTexture({
      size: { width, height, depth: 1 },
      sampleCount: SAMPLE_COUNT,
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.OUTPUT_ATTACHMENT
    });
    this.depthAttachment.attachment = depthTexture.createView();
  }

  async setGltf(gltf) {
    const gl = this.gl;
    const resourcePromises = [];

    for (let bufferView of gltf.bufferViews) {
      resourcePromises.push(this.initBufferView(bufferView));
    }

    for (let image of gltf.images) {
      resourcePromises.push(this.initImage(image));
    }

    for (let sampler of gltf.samplers) {
      this.initSampler(sampler);
    }

    this.initNode(gltf.scene);

    await Promise.all(resourcePromises);

    for (let material of gltf.materials) {
      this.initMaterial(material);
    }

    for (let primitive of gltf.primitives) {
      this.initPrimitive(primitive);
    }
  }

  async initBufferView(bufferView) {
    let usage = 0;
    if (bufferView.usage.has('vertex')) {
      usage |= GPUBufferUsage.VERTEX;
    }
    if (bufferView.usage.has('index')) {
      usage |= GPUBufferUsage.INDEX;
    }

    if (!usage) {
      return;
    }

    const gpuBuffer = this.device.createBuffer({
      size: bufferView.byteLength,
      usage: usage | GPUBufferUsage.COPY_DST
    });
    bufferView.renderData.gpuBuffer = gpuBuffer;

    const bufferData = await bufferView.dataView;
    gpuBuffer.setSubData(0, bufferData);
  }

  async initImage(image) {
    //await image.decode();
    const imageBitmap = await createImageBitmap(image);

    const textureSize = {
      width: imageBitmap.width,
      height: imageBitmap.height,
      depth: 1,
    };

    const texture = this.device.createTexture({
      size: textureSize,
      format: "rgba8unorm",
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.SAMPLED,
    });
    this.device.defaultQueue.copyImageBitmapToTexture({ imageBitmap }, { texture }, textureSize);

    // TODO: Generate mipmaps

    image.gpuTexture = texture;
  }

  initSampler(sampler) {
    const samplerDescriptor = {};

    switch (sampler.minFilter) {
      case GL.LINEAR:
      case GL.LINEAR_MIPMAP_NEAREST:
        samplerDescriptor.minFilter = "linear";
        break;
      case GL.NEAREST_MIPMAP_LINEAR:
        samplerDescriptor.mipmapFilter = "linear";
        break;
      case GL.LINEAR_MIPMAP_LINEAR:
        samplerDescriptor.minFilter = "linear";
        samplerDescriptor.mipmapFilter = "linear";
        break;
    }

    if (sampler.magFilter == GL.LINEAR) {
      samplerDescriptor.magFilter = "linear";
    }

    switch (sampler.wrapS) {
      case GL.REPEAT:
        samplerDescriptor.addressModeU = "repeat";
        break;
      case GL.MIRRORED_REPEAT:
        samplerDescriptor.addressModeU = "mirror-repeat";
        break;
    }

    switch (sampler.wrapT) {
      case GL.REPEAT:
        samplerDescriptor.addressModeV = "repeat";
        break;
      case GL.MIRRORED_REPEAT:
        samplerDescriptor.addressModeV = "mirror-repeat";
        break;
    }

    sampler.renderData.gpuSampler = this.device.createSampler(samplerDescriptor);
  }

  initMaterial(material) {
    // Can reuse these for every PBR material
    const materialUniforms = new Float32Array(4 + 4 + 4);
    const baseColorFactor = new Float32Array(materialUniforms.buffer, 0, 4);
    const metallicRoughnessFactor = new Float32Array(materialUniforms.buffer, 4 * 4, 2);
    const emissiveFactor = new Float32Array(materialUniforms.buffer, 8 * 4, 3);

    vec4.copy(baseColorFactor, material.baseColorFactor);
    vec2.copy(metallicRoughnessFactor, material.metallicRoughnessFactor);
    vec3.copy(emissiveFactor, material.emissiveFactor);

    const materialUniformsBuffer = this.device.createBuffer({
      size: materialUniforms.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    materialUniformsBuffer.setSubData(0, materialUniforms);

    const materialBindGroup = this.device.createBindGroup({
      layout: this.materialUniformsBindGroupLayout,
      bindings: [{
        binding: 0,
        resource: {
          buffer: materialUniformsBuffer,
        },
      },
      {
        binding: 1,
        resource: material.baseColorTexture.image.gpuTexture.createView(),
      },
      {
        binding: 2,
        resource: material.baseColorTexture.sampler.renderData.gpuSampler,
      }],
    });

    material.renderData.gpuBindGroup = materialBindGroup;
  }

  initPrimitive(primitive) {
    const material = primitive.material;

    const vertexBuffers = [];
    for (let [bufferView, attributes] of primitive.attributeBuffers) {
      let arrayStride = bufferView.byteStride;

      const attributeLayouts = [];
      for (let attribName in attributes) {
        const attribute = attributes[attribName];

        const count = attribute.componentCount > 1 ? `${attribute.componentCount}` : '';
        const norm = attribute.normalized ? 'norm' : '';

        let format;
        switch(attribute.componentType) {
          case GL.BYTE:
            format = `char${count}${norm}`;
            break;
          case GL.UNSIGNED_BYTE:
            format = `uchar${count}${norm}`;
            break;
          case GL.SHORT:
            format = `short${count}${norm}`;
            break;
          case GL.UNSIGNED_SHORT:
            format = `ushort${count}${norm}`;
            break;
          case GL.UNSIGNED_INT:
            format = `uint${count}`;
            break;
          case GL.FLOAT:
            format = `float${count}`;
            break;
        }

        attributeLayouts.push({
          shaderLocation: ATTRIB_MAP[attribName],
          offset: attribute.byteOffset,
          format
        });

        if (!bufferView.byteStride) {
          arrayStride += attribute.packedByteStride;
        }
      }

      vertexBuffers.push({
        arrayStride,
        attributes: attributeLayouts,
      });
    }

    primitive.renderData.gpuVertexState = {
      vertexBuffers
    };

    if (primitive.indices && primitive.indices.type == GL.UNSIGNED_SHORT) {
      primitive.renderData.gpuVertexState.indexFormat = 'uint16';
    }

    if (primitive.renderData.instances.length) {
      const primitiveUniformsBuffer = this.device.createBuffer({
        size: 16 * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      // TODO: Support multiple instances
      primitiveUniformsBuffer.setSubData(0, primitive.renderData.instances[0]);

      const primitiveBindGroup = this.device.createBindGroup({
        layout: this.primitiveUniformsBindGroupLayout,
        bindings: [{
          binding: 0,
          resource: {
            buffer: primitiveUniformsBuffer,
          },
        }],
      });

      primitive.renderData.gpuBindGroup = primitiveBindGroup;

      // TODO: This needs some SERIOUS de-duping
      this.createPipeline(primitive);
    }
  }

  createPipeline(primitive) {
    const material = primitive.material;

    let primitiveTopology;
    switch (primitive.mode) {
      case GL.TRIANGLES:
        primitiveTopology = 'triangle-list';
        break;
      case GL.TRIANGLE_STRIP:
        primitiveTopology = 'triangle-strip';
        break;
      case GL.LINES:
        primitiveTopology = 'line-list';
        break;
      case GL.LINE_STRIP:
        primitiveTopology = 'line-strip';
        break;
      case GL.POINTS:
        primitiveTopology = 'point-list';
        break;
      default:
        // LINE_LOOP and TRIANGLE_FAN are straight up unsupported.
        return;
    }
    const cullMode = material.cullFace ? 'back' : 'none';

    const vertexState = primitive.renderData.gpuVertexState;

    // Generate a key that describes this pipeline's layout/state
    let pipelineKey = `${primitiveTopology}|${cullMode}|`;
    let i = 0;
    for (let vertexBuffer of vertexState.vertexBuffers) {
      pipelineKey += `${i}:${vertexBuffer.arrayStride}`;
      for (let attribute of vertexBuffer.attributes) {
        pipelineKey += `:${attribute.shaderLocation},${attribute.offset},${attribute.format}`;
      }
      pipelineKey += '|'
      i++;
    }

    if (vertexState.indexFormat) {
      pipelineKey += `${vertexState.indexFormat}`;
    }

    let pipeline = this.pipelines.get(pipelineKey);

    if (!pipeline) {
      pipeline = this.device.createRenderPipeline({
        vertexStage: this.pbrShaderModule.vertexStage,
        fragmentStage: this.pbrShaderModule.fragmentStage,

        primitiveTopology,

        vertexState,

        rasterizationState: {
          cullMode,
        },

        // Everything below here is (currently) identical for each pipeline
        layout: this.pipelineLayout,
        colorStates: [{
          format: this.swapChainFormat,
          // TODO: Bend mode goes here
        }],
        depthStencilState: {
          depthWriteEnabled: true,
          depthCompare: 'less',
          format: DEPTH_FORMAT,
        },
        SAMPLE_COUNT,
      });
      this.pipelines.set(pipelineKey, pipeline);
      this.pipelineMaterials.set(pipeline, new Map());
    }

    let pipelineMaterialPrimitives = this.pipelineMaterials.get(pipeline);

    let materialPrimitives = pipelineMaterialPrimitives.get(primitive.material);
    if (!materialPrimitives) {
      materialPrimitives = [];
      pipelineMaterialPrimitives.set(primitive.material, materialPrimitives);
    }

    materialPrimitives.push(primitive);
  }

  initNode(node) {
    for (let primitive of node.primitives) {
      if (!primitive.renderData.instances) {
        primitive.renderData.instances = [];
      }
      primitive.renderData.instances.push(node.worldMatrix);
    }

    for (let childNode of node.children) {
      this.initNode(childNode);
    }
  }

  onFrame(timestamp) {
    // Update the FrameUniforms buffer with the values that are used by every
    // program and don't change for the duration of the frame.
    mat4.copy(this.viewMatrix, this.camera.viewMatrix);
    vec3.copy(this.cameraPosition, this.camera.position);
    this.frameUniformsBuffer.setSubData(0, this.frameUniforms);

    // TODO: If we want multisampling this should attach to the resolveTarget,
    // but there seems to be a bug with that right now?
    this.colorAttachment.attachment = this.swapChain.getCurrentTexture().createView();

    const commandEncoder = this.device.createCommandEncoder({});
    const passEncoder = commandEncoder.beginRenderPass(this.renderPassDescriptor);

    passEncoder.setBindGroup(0, this.frameUniformBindGroup);

    for (let pipeline of this.pipelines.values()) {
      passEncoder.setPipeline(pipeline);
      const materialPrimitives = this.pipelineMaterials.get(pipeline);
      for (let [material, primitives] of materialPrimitives) {
        passEncoder.setBindGroup(1, material.renderData.gpuBindGroup);

        for (let primitive of primitives) {
          passEncoder.setBindGroup(2, primitive.renderData.gpuBindGroup);

          let i = 0;
          for (let bufferView of primitive.attributeBuffers.keys()) {
            passEncoder.setVertexBuffer(i, bufferView.renderData.gpuBuffer);
            i++;
          }

          if (primitive.indices) {
            passEncoder.setIndexBuffer(primitive.indices.bufferView.renderData.gpuBuffer, primitive.indices.byteOffset);
            passEncoder.drawIndexed(primitive.elementCount, 1, 0, 0, 0);
          } else {
            passEncoder.draw(primitive.elementCount, 1, 0, 0);
          }
        }
      }
    }

    passEncoder.endPass();
    this.device.defaultQueue.submit([commandEncoder.finish()]);
  }
}