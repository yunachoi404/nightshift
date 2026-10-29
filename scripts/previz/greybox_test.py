"""Render a tiny greybox layout clip plus a colour first frame, for smoke-testing Layout-To-Render.

    blender -b --python scripts/previz/greybox_test.py -- <out_dir>

Writes <out_dir>/layout.mp4 (grey clay, workbench) and <out_dir>/look_seed.png (EEVEE, flat colours).
"""

import math
import os
import subprocess
import sys

import bpy

out = os.path.abspath(sys.argv[sys.argv.index("--") + 1])
os.makedirs(out, exist_ok=True)

W, H, FPS, FRAMES = 960, 544, 24, 97

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.resolution_x, scene.render.resolution_y = W, H
scene.render.fps = FPS
scene.frame_start, scene.frame_end = 1, FRAMES


def material(name, rgb):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1)
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*rgb, 1)
    return m


def box(name, loc, size, mat):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    o = bpy.context.object
    o.name = name
    o.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    o.data.materials.append(mat)
    return o


asphalt = material("asphalt", (0.08, 0.08, 0.09))
concrete = material("concrete", (0.55, 0.5, 0.45))
glass = material("glass", (0.25, 0.35, 0.45))
coat = material("coat", (0.5, 0.12, 0.08))

box("street", (0, 20, -0.05), (14, 80, 0.1), asphalt)
for i, y in enumerate(range(4, 60, 9)):
    h = 10 + (i * 7) % 14
    box(f"bldg_l{i}", (-11, y, h / 2), (8, 7, h), concrete if i % 2 else glass)
    box(f"bldg_r{i}", (11, y + 4, (h + 4) / 2), (8, 7, h + 4), glass if i % 2 else concrete)

# Mannequin: body, head; walks away from camera down the street.
bpy.ops.mesh.primitive_cylinder_add(radius=0.25, depth=1.4, location=(0, 0, 0.9))
body = bpy.context.object
body.data.materials.append(coat)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.14, location=(0, 0, 1.78))
head = bpy.context.object
head.data.materials.append(concrete)
head.parent = body
head.location = (0, 0, 0.88)
for f, y in ((1, 6.0), (FRAMES, 10.0)):
    body.location = (0.6, y, 0.7)
    body.keyframe_insert("location", frame=f)

# Camera: low dolly-in that follows the walker.
bpy.ops.object.camera_add()
cam = bpy.context.object
cam.data.lens = 28
scene.camera = cam
for f, y, z in ((1, -2.0, 1.2), (FRAMES, 4.5, 1.5)):
    cam.location = (-1.2, y, z)
    cam.rotation_euler = (math.radians(86), 0, math.radians(-6))
    cam.keyframe_insert("location", frame=f)
    cam.keyframe_insert("rotation_euler", frame=f)

bpy.ops.object.light_add(type="SUN", location=(0, 0, 20))
bpy.context.object.rotation_euler = (math.radians(50), 0, math.radians(35))
bpy.context.object.data.energy = 4
world = bpy.data.worlds.new("w")
world.color = (0.5, 0.6, 0.75)
scene.world = world

# Layout clip: grey clay viewport look.
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "SINGLE"
scene.display.shading.single_color = (0.7, 0.7, 0.7)
scene.render.image_settings.file_format = "PNG"
frames = os.path.join(out, "layout_frames")
scene.render.filepath = os.path.join(frames, "f_")
bpy.ops.render.render(animation=True)
subprocess.run(
    ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", os.path.join(frames, "f_%04d.png"),
     "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", os.path.join(out, "layout.mp4")],
    check=True,
)

# Colour still of frame 1, a crude seed for the art-direction first frame.
scene.frame_set(1)
scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in {
    e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items
} else "BLENDER_EEVEE"
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = os.path.join(out, "look_seed.png")
bpy.ops.render.render(write_still=True)
print("wrote", out)
