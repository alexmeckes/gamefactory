using UnityEngine;
using UnityEngine.Rendering;

namespace PullingSeason
{
    public sealed class PrototypeBootstrap : MonoBehaviour
    {
        private void Awake()
        {
            if (GameObject.Find("World") != null) return;
            BuildWorld();
        }

        private static void BuildWorld()
        {
            var soil = MakeMaterial("Soil", new Color(0.27f, 0.16f, 0.09f));
            var looseSoil = MakeMaterial("Loose Soil", new Color(0.50f, 0.31f, 0.15f));
            var grass = MakeMaterial("Grass", new Color(0.18f, 0.34f, 0.16f));
            var wood = MakeMaterial("Wood", new Color(0.38f, 0.22f, 0.10f));
            var leaf = MakeMaterial("Leaf", new Color(0.23f, 0.55f, 0.20f));
            var leafBright = MakeMaterial("Leaf Bright", new Color(0.48f, 0.76f, 0.24f));
            var early = MakeMaterial("Early Crop", new Color(0.91f, 0.48f, 0.20f));
            var late = MakeMaterial("Late Crop", new Color(0.86f, 0.24f, 0.11f));
            var damaged = MakeMaterial("Damaged Crop", new Color(0.48f, 0.12f, 0.09f));
            var crack = MakeMaterial("Root Crack", new Color(0.12f, 0.055f, 0.025f));
            var playerMaterial = MakeMaterial("Player Body", new Color(0.15f, 0.35f, 0.42f));
            var glove = MakeMaterial("Gloves", new Color(0.93f, 0.71f, 0.34f));
            var rope = MakeMaterial("Grip Tether", new Color(1f, 0.84f, 0.35f), true);
            var dormant = MakeMaterial("Dormant Bed", new Color(0.26f, 0.31f, 0.22f));
            var available = MakeMaterial("Available Bed", new Color(0.70f, 0.77f, 0.18f));
            var panel = MakeMaterial("Readout Panel", new Color(0.035f, 0.055f, 0.05f), true);
            var earlyProgress = MakeMaterial("Early Progress", new Color(0.47f, 0.88f, 0.42f), true);
            var lateProgress = MakeMaterial("Late Progress", new Color(1f, 0.67f, 0.20f), true);
            var damageProgress = MakeMaterial("Damage Progress", new Color(1f, 0.26f, 0.18f), true);

            RenderSettings.ambientLight = new Color(0.43f, 0.48f, 0.50f);
            RenderSettings.fog = true;
            RenderSettings.fogColor = new Color(0.56f, 0.69f, 0.69f);
            RenderSettings.fogMode = FogMode.Linear;
            RenderSettings.fogStartDistance = 14f;
            RenderSettings.fogEndDistance = 30f;

            var world = new GameObject("World");
            world.SetActive(false);
            AddLighting(world.transform);
            Primitive("Ground", PrimitiveType.Plane, world.transform, Vector3.zero, new Vector3(2.8f, 1f, 2.2f), grass, true);
            AddField(world.transform, soil, looseSoil, wood, crack);

            var nextCropObject = AddNextCrop(world.transform, soil, leaf, dormant, available);
            var nextDecision = nextCropObject.GetComponent<NextHarvestDecision>();

            var cropObject = new GameObject("Crop");
            cropObject.transform.SetParent(world.transform);
            cropObject.transform.localPosition = new Vector3(0f, 0.10f, 0f);
            var cropBody = cropObject.AddComponent<Rigidbody>();
            cropBody.isKinematic = true;
            cropBody.interpolation = RigidbodyInterpolation.Interpolate;
            cropBody.collisionDetectionMode = CollisionDetectionMode.ContinuousSpeculative;
            var cropCollider = cropObject.AddComponent<CapsuleCollider>();
            cropCollider.center = new Vector3(0f, 0.65f, 0f);
            cropCollider.radius = 0.58f;
            cropCollider.height = 1.45f;

            var visual = new GameObject("CropVisual");
            visual.transform.SetParent(cropObject.transform, false);
            var bulb = Primitive("Bulb", PrimitiveType.Sphere, visual.transform, new Vector3(0f, 0.62f, 0f), new Vector3(1.15f, 1.34f, 1.12f), early);
            AddLeaves(visual.transform, leaf, leafBright);
            var damageMarks = AddDamageMarks(visual.transform, damaged);
            var gripLine = cropObject.AddComponent<LineRenderer>();
            gripLine.positionCount = 2;
            gripLine.startWidth = 0.035f;
            gripLine.endWidth = 0.022f;
            gripLine.material = rope;
            gripLine.shadowCastingMode = ShadowCastingMode.Off;
            gripLine.receiveShadows = false;
            gripLine.enabled = false;
            var soilBurst = AddSoilFeedback(cropObject.transform, looseSoil);
            var soilResponse = AddRootSocket(world.transform, looseSoil, crack);
            var lateCues = AddLateCues(world.transform, crack);
            lateCues.SetActive(false);

            var harvest = cropObject.AddComponent<HarvestCrop>();
            harvest.Configure(nextDecision, visual.transform, bulb.GetComponent<Renderer>(), early, late, damaged,
                lateCues, damageMarks, gripLine, soilBurst, soilResponse.transform);

            var player = AddPlayer(world.transform, playerMaterial, glove, harvest);
            AddDisplay(player, harvest, nextDecision, panel, earlyProgress, lateProgress, damageProgress);
            AddCropSign(world.transform, wood);
            world.SetActive(true);
        }

        private static void AddLighting(Transform world)
        {
            var lightObject = new GameObject("Sun");
            lightObject.transform.SetParent(world);
            lightObject.transform.rotation = Quaternion.Euler(42f, -28f, 0f);
            var light = lightObject.AddComponent<Light>();
            light.type = LightType.Directional;
            light.color = new Color(1f, 0.90f, 0.72f);
            light.intensity = 1.25f;
            light.shadows = LightShadows.Soft;
        }

        private static void AddField(Transform world, Material soil, Material looseSoil, Material wood, Material crack)
        {
            for (var row = -2; row <= 2; row++)
                Primitive("SoilRow_" + row, PrimitiveType.Cube, world, new Vector3(1.2f, 0.055f, row * 2.25f),
                    new Vector3(10.5f, 0.09f, 1.25f), row == 0 ? looseSoil : soil);

            for (var side = -1; side <= 1; side += 2)
            {
                for (var x = -7; x <= 9; x += 2)
                    Primitive("FencePost", PrimitiveType.Cube, world, new Vector3(x, 0.55f, side * 5.8f), new Vector3(0.12f, 1.1f, 0.12f), wood);
                Primitive("FenceRail", PrimitiveType.Cube, world, new Vector3(1f, 0.7f, side * 5.8f), new Vector3(16f, 0.10f, 0.10f), wood);
            }

            for (var index = 0; index < 4; index++)
            {
                var seam = Primitive("EarlySoilSeam_" + index, PrimitiveType.Cube, world,
                    new Vector3(Mathf.Cos(index * Mathf.PI * 0.5f) * 0.72f, 0.12f, Mathf.Sin(index * Mathf.PI * 0.5f) * 0.72f),
                    new Vector3(0.52f, 0.018f, 0.045f), crack);
                seam.transform.rotation = Quaternion.Euler(0f, -index * 90f + 22f, 0f);
            }
        }

        private static void AddLeaves(Transform visual, Material leaf, Material bright)
        {
            Primitive("Stem", PrimitiveType.Cylinder, visual, new Vector3(0f, 1.45f, 0f), new Vector3(0.16f, 0.46f, 0.16f), leaf);
            for (var index = 0; index < 7; index++)
            {
                var angle = index * (360f / 7f);
                var radians = angle * Mathf.Deg2Rad;
                var leafObject = Primitive("Leaf_" + index, PrimitiveType.Capsule, visual,
                    new Vector3(Mathf.Cos(radians) * 0.28f, 1.75f, Mathf.Sin(radians) * 0.28f),
                    new Vector3(0.12f, 0.52f, 0.18f), index % 2 == 0 ? bright : leaf);
                leafObject.transform.localRotation = Quaternion.Euler(Mathf.Sin(radians) * 42f, angle, -Mathf.Cos(radians) * 42f);
            }
        }

        private static GameObject AddDamageMarks(Transform visual, Material damaged)
        {
            var root = new GameObject("VisibleDamageMarks");
            root.transform.SetParent(visual, false);
            for (var index = 0; index < 3; index++)
            {
                var mark = Primitive("Bruise_" + index, PrimitiveType.Cube, root.transform,
                    new Vector3(-0.48f + index * 0.22f, 0.62f + index * 0.13f, -0.40f),
                    new Vector3(0.12f, 0.28f, 0.055f), damaged);
                mark.transform.localRotation = Quaternion.Euler(0f, 0f, 24f - index * 19f);
            }
            root.SetActive(false);
            return root;
        }

        private static ParticleSystem AddSoilFeedback(Transform crop, Material soil)
        {
            var feedback = new GameObject("SoilFeedback");
            feedback.transform.SetParent(crop, false);
            feedback.transform.localPosition = Vector3.up * 0.08f;
            var particles = feedback.AddComponent<ParticleSystem>();
            var main = particles.main;
            main.loop = false;
            main.playOnAwake = false;
            main.duration = 0.35f;
            main.startLifetime = 0.42f;
            main.startSpeed = 1.7f;
            main.startSize = 0.10f;
            main.startColor = new Color(0.45f, 0.25f, 0.10f);
            var emission = particles.emission;
            emission.rateOverTime = 0f;
            var shape = particles.shape;
            shape.shapeType = ParticleSystemShapeType.Circle;
            shape.radius = 0.65f;
            feedback.GetComponent<ParticleSystemRenderer>().material = soil;
            return particles;
        }

        private static GameObject AddRootSocket(Transform world, Material looseSoil, Material crack)
        {
            var root = new GameObject("RootSocket");
            root.transform.SetParent(world);
            root.transform.localPosition = new Vector3(0f, 0.125f, 0f);
            Primitive("CompressionPlate", PrimitiveType.Cylinder, root.transform, Vector3.zero,
                new Vector3(1.34f, 0.018f, 1.34f), looseSoil);
            for (var index = 0; index < 12; index++)
            {
                var angle = index * 30f;
                var radians = angle * Mathf.Deg2Rad;
                var clod = Primitive("RootClod_" + index, PrimitiveType.Cube, root.transform,
                    new Vector3(Mathf.Cos(radians) * 0.72f, 0.035f, Mathf.Sin(radians) * 0.72f),
                    new Vector3(0.28f, 0.07f, 0.12f), index % 3 == 0 ? crack : looseSoil);
                clod.transform.localRotation = Quaternion.Euler(0f, -angle, (index % 2 == 0 ? 1f : -1f) * 4f);
            }
            return root;
        }

        private static GameObject AddLateCues(Transform world, Material crack)
        {
            var root = new GameObject("LateSoilCues");
            root.transform.SetParent(world);
            for (var index = 0; index < 9; index++)
            {
                var angle = index * 40f;
                var radians = angle * Mathf.Deg2Rad;
                var seam = Primitive("DryCrack_" + index, PrimitiveType.Cube, root.transform,
                    new Vector3(Mathf.Cos(radians) * (0.7f + index % 3 * 0.18f), 0.14f, Mathf.Sin(radians) * (0.7f + index % 3 * 0.18f)),
                    new Vector3(0.5f + index % 2 * 0.22f, 0.025f, 0.055f), crack);
                seam.transform.rotation = Quaternion.Euler(0f, -angle + 18f, 0f);
            }
            return root;
        }

        private static GameObject AddNextCrop(Transform world, Material soil, Material leaf, Material dormant, Material available)
        {
            var root = new GameObject("NextCrop");
            root.transform.SetParent(world);
            root.transform.localPosition = new Vector3(3.3f, 0.08f, 2.45f);
            Primitive("NextBed", PrimitiveType.Cylinder, root.transform, Vector3.zero, new Vector3(1.1f, 0.05f, 1.1f), soil, true);
            var bulb = Primitive("CueBulb", PrimitiveType.Sphere, root.transform, new Vector3(0f, 0.52f, 0f), new Vector3(0.82f, 0.92f, 0.82f), dormant);
            for (var index = 0; index < 4; index++)
            {
                var cueLeaf = Primitive("CueLeaf_" + index, PrimitiveType.Capsule, root.transform,
                    new Vector3((index - 1.5f) * 0.13f, 1.14f, 0f), new Vector3(0.08f, 0.38f, 0.10f), leaf);
                cueLeaf.transform.localRotation = Quaternion.Euler(0f, index * 35f, (index - 1.5f) * 16f);
            }
            var beacon = Primitive("DecisionBeacon", PrimitiveType.Cylinder, root.transform, new Vector3(0f, 1.75f, 0f), new Vector3(0.38f, 0.035f, 0.38f), available);
            beacon.SetActive(false);
            var label = WorldText("DecisionLabel", root.transform, "NEXT BED\nObserve after harvest", new Vector3(0f, 1.65f, -0.55f), 0.055f, new Color(0.72f, 0.77f, 0.66f));
            label.transform.rotation = Quaternion.LookRotation((label.transform.position - new Vector3(-3f, 1.5f, 0f)).normalized);
            var decision = root.AddComponent<NextHarvestDecision>();
            decision.Configure(bulb.GetComponent<Renderer>(), dormant, available, beacon, label);
            return root;
        }

        private static GameObject AddPlayer(Transform world, Material bodyMaterial, Material gloveMaterial, HarvestCrop crop)
        {
            var player = new GameObject("Player");
            player.transform.SetParent(world);
            player.transform.localPosition = new Vector3(-3f, 0.95f, 0f);
            var rigidbody = player.AddComponent<Rigidbody>();
            rigidbody.isKinematic = true;
            rigidbody.useGravity = false;
            rigidbody.constraints = RigidbodyConstraints.FreezeRotation;
            var capsule = player.AddComponent<CapsuleCollider>();
            capsule.height = 1.8f;
            capsule.radius = 0.34f;
            Primitive("VisibleBody", PrimitiveType.Capsule, player.transform, new Vector3(-0.08f, -0.26f, 0f), new Vector3(0.62f, 0.78f, 0.62f), bodyMaterial);

            var cameraObject = new GameObject("FirstPersonCamera");
            cameraObject.tag = "MainCamera";
            cameraObject.transform.SetParent(player.transform, false);
            cameraObject.transform.localPosition = new Vector3(0f, 0.56f, 0f);
            cameraObject.transform.localRotation = Quaternion.Euler(0f, 90f, 0f);
            var camera = cameraObject.AddComponent<Camera>();
            camera.fieldOfView = 62f;
            camera.nearClipPlane = 0.05f;
            camera.farClipPlane = 60f;
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(0.52f, 0.68f, 0.72f);
            cameraObject.AddComponent<AudioListener>();

            var leftHand = Primitive("LeftHand", PrimitiveType.Cube, cameraObject.transform, new Vector3(-0.19f, -0.23f, 0.68f), new Vector3(0.15f, 0.13f, 0.32f), gloveMaterial);
            var rightHand = Primitive("RightHand", PrimitiveType.Cube, cameraObject.transform, new Vector3(0.19f, -0.23f, 0.68f), new Vector3(0.15f, 0.13f, 0.32f), gloveMaterial);
            var gripAnchor = new GameObject("GripAnchor");
            gripAnchor.transform.SetParent(cameraObject.transform, false);
            gripAnchor.transform.localPosition = new Vector3(0f, -0.12f, 0.73f);
            var controller = player.AddComponent<FirstPersonPullController>();
            controller.Configure(crop, cameraObject.transform, leftHand.transform, rightHand.transform, gripAnchor.transform);
            return player;
        }

        private static void AddDisplay(GameObject player, HarvestCrop crop, NextHarvestDecision nextDecision, Material panel,
            Material earlyProgress, Material lateProgress, Material damageProgress)
        {
            var camera = player.GetComponentInChildren<Camera>(true).transform;
            var root = new GameObject("FieldReadout");
            root.transform.SetParent(camera, false);
            Panel("CuePanel", root.transform, new Vector3(-0.43f, 0.22f, 0.78f), new Vector3(0.56f, 0.26f, 1f), panel);
            Panel("StatusPanel", root.transform, new Vector3(0.45f, 0.26f, 0.78f), new Vector3(0.43f, 0.18f, 1f), panel);
            Panel("ControlPanel", root.transform, new Vector3(0f, -0.36f, 0.86f), new Vector3(1.15f, 0.105f, 1f), panel);
            CameraText("Title", root.transform, "PULLING SEASON  //  EMBODIED FIELD TEST", new Vector3(-0.70f, 0.385f, 0.74f), TextAnchor.UpperLeft, 0.024f, new Color(1f, 0.83f, 0.37f));
            var cue = CameraText("CueReadout", root.transform, "", new Vector3(-0.68f, 0.335f, 0.74f), TextAnchor.UpperLeft, 0.022f, new Color(0.86f, 0.95f, 0.81f));
            var status = CameraText("PullStatus", root.transform, "", new Vector3(0.255f, 0.335f, 0.74f), TextAnchor.UpperLeft, 0.021f, new Color(0.82f, 1f, 0.72f));
            var controls = CameraText("Controls", root.transform, "", new Vector3(0f, -0.325f, 0.82f), TextAnchor.MiddleCenter, 0.019f, new Color(0.88f, 0.92f, 0.85f));
            var track = Panel("ProgressTrack", root.transform, new Vector3(0.445f, 0.175f, 0.735f), new Vector3(0.36f, 0.023f, 1f), panel);
            var fill = Panel("ProgressFill", track.transform, new Vector3(-0.49f, 0f, -0.006f), new Vector3(0.02f, 0.55f, 1f), earlyProgress);
            var display = root.AddComponent<PrototypeDisplay>();
            display.Configure(crop, nextDecision, cue, status, controls, fill.transform, fill.GetComponent<Renderer>(), earlyProgress, lateProgress, damageProgress);
        }

        private static void AddCropSign(Transform world, Material wood)
        {
            Primitive("ReadinessSignPost", PrimitiveType.Cube, world, new Vector3(-0.15f, 0.75f, -1.65f), new Vector3(0.08f, 1.45f, 0.08f), wood);
            var label = WorldText("ReadinessSign", world, "CROWN + SOIL\nREAD BEFORE YOU PULL", new Vector3(-0.15f, 1.42f, -1.62f), 0.045f, new Color(0.15f, 0.08f, 0.035f));
            label.transform.rotation = Quaternion.LookRotation((label.transform.position - new Vector3(-3f, 1.5f, 0f)).normalized);
        }

        private static Material MakeMaterial(string name, Color color, bool unlit = false)
        {
            var shader = Shader.Find(unlit ? "Unlit/Color" : "Standard");
            if (shader == null) shader = Shader.Find("Universal Render Pipeline/Lit");
            var material = new Material(shader) { name = name, color = color };
            if (material.HasProperty("_Glossiness")) material.SetFloat("_Glossiness", 0.18f);
            return material;
        }

        private static GameObject Primitive(string name, PrimitiveType type, Transform parent, Vector3 position, Vector3 scale, Material material, bool keepCollider = false)
        {
            var result = GameObject.CreatePrimitive(type);
            result.name = name;
            result.transform.SetParent(parent, false);
            result.transform.localPosition = position;
            result.transform.localScale = scale;
            if (material != null) result.GetComponent<Renderer>().material = material;
            if (!keepCollider)
            {
                var collider = result.GetComponent<Collider>();
                if (collider != null) Object.Destroy(collider);
            }
            return result;
        }

        private static GameObject Panel(string name, Transform parent, Vector3 position, Vector3 scale, Material material)
        {
            return Primitive(name, PrimitiveType.Quad, parent, position, scale, material);
        }

        private static TextMesh CameraText(string name, Transform parent, string text, Vector3 position, TextAnchor anchor, float size, Color color)
        {
            var result = WorldText(name, parent, text, position, size, color);
            result.anchor = anchor;
            result.alignment = anchor == TextAnchor.MiddleCenter ? TextAlignment.Center : TextAlignment.Left;
            return result;
        }

        private static TextMesh WorldText(string name, Transform parent, string text, Vector3 position, float size, Color color)
        {
            var result = new GameObject(name);
            result.transform.SetParent(parent, false);
            result.transform.localPosition = position;
            var mesh = result.AddComponent<TextMesh>();
            mesh.text = text;
            mesh.anchor = TextAnchor.MiddleCenter;
            mesh.alignment = TextAlignment.Center;
            mesh.fontSize = 64;
            mesh.characterSize = size;
            mesh.color = color;
            return mesh;
        }
    }
}
