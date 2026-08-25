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
            var rope = MakeMaterial("Seamline Strap", new Color(0.70f, 0.50f, 0.19f), true);
            var warning = MakeMaterial("Strain Warning", new Color(0.95f, 0.12f, 0.055f), true);
            var growth = MakeMaterial("Growth Pulse", new Color(1f, 0.78f, 0.19f), true);
            var dormant = MakeMaterial("Dormant Bed", new Color(0.26f, 0.31f, 0.22f));
            var available = MakeMaterial("Available Bed", new Color(0.70f, 0.77f, 0.18f));

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
            AddAmbientField(world.transform, leaf, leafBright);
            AddHarvestPatch(world.transform, wood, looseSoil);

            var nextCropObject = AddNextCrop(world.transform, soil, looseSoil, leaf, crack, dormant, available, warning, growth);
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
            AddStrapLoop(world.transform, rope);
            var strapLine = cropObject.AddComponent<LineRenderer>();
            strapLine.positionCount = 4;
            strapLine.startWidth = 0.052f;
            strapLine.endWidth = 0.044f;
            strapLine.numCapVertices = 4;
            strapLine.numCornerVertices = 3;
            strapLine.material = rope;
            strapLine.shadowCastingMode = ShadowCastingMode.Off;
            strapLine.receiveShadows = false;
            strapLine.useWorldSpace = true;
            strapLine.enabled = true;
            var handbar = Primitive("StrapHandbar", PrimitiveType.Cylinder, world.transform,
                new Vector3(-0.82f, 0.36f, 0f), new Vector3(0.075f, 0.42f, 0.075f), rope);
            handbar.transform.rotation = Quaternion.FromToRotation(Vector3.up, Vector3.forward);
            var soilBurst = AddSoilFeedback(cropObject.transform, looseSoil);
            var soilResponse = AddRootSocket(world.transform, looseSoil, crack);
            var lateCues = AddLateCues(world.transform, crack);
            lateCues.SetActive(false);
            var warningSoil = AddWarningSoil(world.transform, warning);
            warningSoil.SetActive(false);
            var growthPulse = AddGrowthPulse(world.transform, growth);
            growthPulse.SetActive(false);

            var harvest = cropObject.AddComponent<HarvestCrop>();
            harvest.Configure(nextDecision, visual.transform, bulb.GetComponent<Renderer>(), early, late, damaged,
                lateCues, damageMarks, strapLine, handbar.transform, handbar.GetComponent<Renderer>(), warningSoil,
                growthPulse, soilBurst, soilResponse.transform);

            var player = AddPlayer(world.transform, playerMaterial, glove, harvest);
            AddDisplay(player, harvest, nextDecision);
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

            // One stronger, imperfect seam points toward the starting side. It is
            // evidence to plan from, not a snap line or guaranteed answer.
            var probableSeam = new GameObject("ProbableReleaseSeam");
            probableSeam.transform.SetParent(world);
            for (var index = 0; index < 5; index++)
            {
                var seam = Primitive("OpenSeam_" + index, PrimitiveType.Cube, probableSeam.transform,
                    new Vector3(-0.48f - index * 0.27f, 0.121f, (index % 2 == 0 ? -1f : 1f) * 0.035f),
                    new Vector3(0.23f, 0.022f, 0.052f), crack);
                seam.transform.localRotation = Quaternion.Euler(0f, (index % 2 == 0 ? -1f : 1f) * 8f, 0f);
            }

            for (var index = 0; index < 4; index++)
            {
                var angle = 38f + index * 71f;
                var radians = angle * Mathf.Deg2Rad;
                var seam = Primitive("HairlineCrack_" + index, PrimitiveType.Cube, world,
                    new Vector3(Mathf.Cos(radians) * 0.86f, 0.116f, Mathf.Sin(radians) * 0.86f),
                    new Vector3(0.27f, 0.012f, 0.025f), crack);
                seam.transform.rotation = Quaternion.Euler(0f, -angle + 17f, 0f);
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

        private static void AddAmbientField(Transform world, Material leaf, Material bright)
        {
            var root = new GameObject("AmbientField");
            root.transform.SetParent(world);
            var stems = new Transform[12];
            for (var index = 0; index < stems.Length; index++)
            {
                var side = index % 2 == 0 ? -1f : 1f;
                var x = -2.2f + (index / 2) * 1.45f;
                var stem = Primitive("FieldLeaf_" + index, PrimitiveType.Capsule, root.transform,
                    new Vector3(x, 0.34f, side * (2.35f + index % 3 * 0.32f)),
                    new Vector3(0.06f, 0.34f + index % 3 * 0.04f, 0.09f), index % 3 == 0 ? bright : leaf);
                stem.transform.localRotation = Quaternion.Euler(side * 9f, index * 23f, side * (8f + index % 4 * 3f));
                stems[index] = stem.transform;
            }

            var motion = root.AddComponent<AmbientFieldMotion>();
            motion.Configure(stems);
        }

        private static void AddHarvestPatch(Transform world, Material wood, Material looseSoil)
        {
            var root = new GameObject("HarvestRestPatch");
            root.transform.SetParent(world);
            root.transform.localPosition = new Vector3(-1.35f, 0.105f, -0.35f);
            Primitive("SoftLanding", PrimitiveType.Cylinder, root.transform, Vector3.zero,
                new Vector3(0.82f, 0.025f, 0.82f), looseSoil);
            for (var index = 0; index < 8; index++)
            {
                var angle = index * 45f;
                var radians = angle * Mathf.Deg2Rad;
                var rim = Primitive("CradleRim_" + index, PrimitiveType.Cube, root.transform,
                    new Vector3(Mathf.Cos(radians) * 0.70f, 0.08f, Mathf.Sin(radians) * 0.70f),
                    new Vector3(0.34f, 0.065f, 0.09f), wood);
                rim.transform.localRotation = Quaternion.Euler(0f, -angle, 0f);
            }
        }

        private static void AddStrapLoop(Transform world, Material rope)
        {
            var root = new GameObject("PreLoopedStrap");
            root.transform.SetParent(world);
            for (var index = 0; index < 10; index++)
            {
                var angle = -132f + index * 29f;
                var radians = angle * Mathf.Deg2Rad;
                var segment = Primitive("LoopSegment_" + index, PrimitiveType.Cylinder, root.transform,
                    new Vector3(Mathf.Cos(radians) * 0.62f, 0.31f, Mathf.Sin(radians) * 0.62f),
                    new Vector3(0.035f, 0.13f, 0.035f), rope);
                segment.transform.localRotation = Quaternion.Euler(90f, angle + 90f, 0f);
            }
        }

        private static GameObject AddWarningSoil(Transform world, Material warning)
        {
            var root = new GameObject("RouteStrainSoil");
            root.transform.SetParent(world);
            for (var index = 0; index < 5; index++)
            {
                var mark = Primitive("StrainMark_" + index, PrimitiveType.Cube, root.transform,
                    new Vector3((index - 2f) * 0.13f, 0f, index * 0.075f),
                    new Vector3(0.12f, 0.025f, 0.035f), warning);
                mark.transform.localRotation = Quaternion.Euler(0f, (index - 2f) * 11f, 0f);
            }
            return root;
        }

        private static GameObject AddGrowthPulse(Transform world, Material growth)
        {
            var root = new GameObject("VisibleGrowthPulse");
            root.transform.SetParent(world);
            root.transform.localPosition = new Vector3(0f, 0.22f, 0f);
            for (var index = 0; index < 10; index++)
            {
                var angle = index * 36f;
                var radians = angle * Mathf.Deg2Rad;
                Primitive("PulseSeed_" + index, PrimitiveType.Sphere, root.transform,
                    new Vector3(Mathf.Cos(radians) * 0.82f, 0.04f, Mathf.Sin(radians) * 0.82f),
                    Vector3.one * 0.075f, growth);
            }
            return root;
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

        private static GameObject AddNextCrop(Transform world, Material soil, Material looseSoil, Material leaf,
            Material crack, Material dormant, Material available, Material warning, Material growth)
        {
            var root = new GameObject("NextCrop");
            root.transform.SetParent(world);
            root.transform.localPosition = new Vector3(2.15f, 0.08f, 1.70f);
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

            var earlyCue = new GameObject("PreviousEarlyCue");
            earlyCue.transform.SetParent(root.transform, false);
            for (var index = 0; index < 8; index++)
            {
                var angle = index * 45f;
                var radians = angle * Mathf.Deg2Rad;
                Primitive("GrowthPromise_" + index, PrimitiveType.Sphere, earlyCue.transform,
                    new Vector3(Mathf.Cos(radians) * 0.76f, 0.16f, Mathf.Sin(radians) * 0.76f),
                    Vector3.one * 0.09f, growth);
            }

            var lateCue = new GameObject("PreviousLateCue");
            lateCue.transform.SetParent(root.transform, false);
            for (var index = 0; index < 6; index++)
            {
                var seam = Primitive("DenseSeam_" + index, PrimitiveType.Cube, lateCue.transform,
                    new Vector3(-0.35f + index * 0.14f, 0.08f, -0.56f - index % 2 * 0.07f),
                    new Vector3(0.13f, 0.018f, 0.035f), index % 2 == 0 ? crack : looseSoil);
                seam.transform.localRotation = Quaternion.Euler(0f, (index - 2f) * 6f, 0f);
            }

            var damagedCue = new GameObject("PreviousDamageCue");
            damagedCue.transform.SetParent(root.transform, false);
            for (var index = 0; index < 5; index++)
            {
                var clod = Primitive("WarningClod_" + index, PrimitiveType.Cube, damagedCue.transform,
                    new Vector3(0.42f + index % 2 * 0.17f, 0.10f, -0.38f + index * 0.17f),
                    new Vector3(0.16f, 0.08f, 0.13f), warning);
                clod.transform.localRotation = Quaternion.Euler(index * 7f, index * 19f, index * 5f);
            }

            var decision = root.AddComponent<NextHarvestDecision>();
            decision.Configure(bulb.GetComponent<Renderer>(), dormant, available, beacon, earlyCue, lateCue, damagedCue, null);
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

        private static void AddDisplay(GameObject player, HarvestCrop crop, NextHarvestDecision nextDecision)
        {
            var camera = player.GetComponentInChildren<Camera>(true).transform;
            var root = new GameObject("FieldReadout");
            root.transform.SetParent(camera, false);
            var display = root.AddComponent<PrototypeDisplay>();
            display.Configure(crop, nextDecision);
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

    }
}
