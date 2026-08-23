using UnityEngine;

namespace PullingSeason
{
    [RequireComponent(typeof(Rigidbody), typeof(Collider))]
    public sealed class HarvestCrop : MonoBehaviour
    {
        public bool Harvested;
        public bool GripActive;
        public float PullProgress;
        public string GrowthStage = "Early";
        public string Condition = "Rooted - intact";
        public bool Acknowledged;

        [Header("Embodied references")]
        [SerializeField] private NextHarvestDecision nextDecision;
        [SerializeField] private Transform cropVisual;
        [SerializeField] private Renderer bulbRenderer;
        [SerializeField] private Material earlyMaterial;
        [SerializeField] private Material lateMaterial;
        [SerializeField] private Material damagedMaterial;
        [SerializeField] private GameObject lateSoilCues;
        [SerializeField] private GameObject damageMarks;
        [SerializeField] private LineRenderer gripLine;
        [SerializeField] private ParticleSystem soilBurst;
        [SerializeField] private Transform soilResponse;
        [SerializeField] private float gripRange = 2.4f;

        private Rigidbody cropBody;
        private FirstPersonPullController grippingPlayer;
        private float mishandledDistance;
        private bool damaged;
        private Vector3 visualRestScale;
        private Vector3 visualTargetScale;
        private Quaternion visualRestRotation;
        private Vector3 rootedPosition;
        private Vector3 lastGripPosition;
        private Vector3 rootDeflection;
        private Vector3 soilRestScale;
        private Quaternion soilRestRotation;
        private float lastSoilMilestone;
        private float feedbackClock;

        private float RequiredPullDistance => GrowthStage == "Late" ? 1.70f : 1.20f;

        public void Configure(NextHarvestDecision targetNextDecision, Transform targetVisual, Renderer targetBulbRenderer,
            Material targetEarlyMaterial, Material targetLateMaterial, Material targetDamagedMaterial,
            GameObject targetLateSoilCues, GameObject targetDamageMarks, LineRenderer targetGripLine,
            ParticleSystem targetSoilBurst, Transform targetSoilResponse)
        {
            nextDecision = targetNextDecision;
            cropVisual = targetVisual;
            bulbRenderer = targetBulbRenderer;
            earlyMaterial = targetEarlyMaterial;
            lateMaterial = targetLateMaterial;
            damagedMaterial = targetDamagedMaterial;
            lateSoilCues = targetLateSoilCues;
            damageMarks = targetDamageMarks;
            gripLine = targetGripLine;
            soilBurst = targetSoilBurst;
            soilResponse = targetSoilResponse;
        }

        private void Awake()
        {
            cropBody = GetComponent<Rigidbody>();
            cropBody.isKinematic = true;
            cropBody.useGravity = false;
            rootedPosition = cropBody.position;
            if (cropVisual != null)
            {
                visualRestScale = cropVisual.localScale;
                visualTargetScale = visualRestScale;
                visualRestRotation = cropVisual.localRotation;
            }
            if (soilResponse != null)
            {
                soilRestScale = soilResponse.localScale;
                soilRestRotation = soilResponse.localRotation;
            }
            if (lateSoilCues != null) lateSoilCues.SetActive(false);
            if (damageMarks != null) damageMarks.SetActive(false);
            if (gripLine != null) gripLine.enabled = false;
        }

        private void Update()
        {
            if (gripLine != null && GripActive && grippingPlayer != null && !Harvested)
            {
                gripLine.enabled = true;
                gripLine.SetPosition(0, grippingPlayer.GripAnchor.position);
                gripLine.SetPosition(1, transform.position + Vector3.up * 1.0f);
            }
            else if (gripLine != null)
            {
                gripLine.enabled = false;
            }

            if (cropVisual != null && !Harvested)
            {
                feedbackClock += Time.deltaTime;
                cropVisual.localScale = Vector3.Lerp(cropVisual.localScale, visualTargetScale, 0.13f);
                var tension = GripActive ? 2.5f + PullProgress * 5f : 1.2f;
                var wobble = Mathf.Sin(feedbackClock * tension) * (GripActive ? 3f + PullProgress * 7f : 0.7f);
                cropVisual.localRotation = visualRestRotation * Quaternion.Euler(0f, 0f, wobble);
            }

            UpdateSoilResponse();
        }

        private void LateUpdate()
        {
            if (!GripActive || Harvested || grippingPlayer == null) return;

            var currentGripPosition = grippingPlayer.transform.position;
            var playerDelta = Vector3.ProjectOnPlane(currentGripPosition - lastGripPosition, Vector3.up);
            lastGripPosition = currentGripPosition;
            if (playerDelta.sqrMagnitude < 0.000001f) return;

            ApplyObservedPlayerMotion(currentGripPosition - playerDelta, playerDelta.normalized, playerDelta.magnitude);
        }

        public void CommitLate()
        {
            if (Harvested || GrowthStage == "Late") return;
            GrowthStage = "Late";
            Condition = "Rooted - dense roots";
            if (cropVisual != null)
            {
                visualTargetScale = visualRestScale * 1.2f;
                visualRestScale = visualTargetScale;
            }
            if (bulbRenderer != null && lateMaterial != null) bulbRenderer.material = lateMaterial;
            if (lateSoilCues != null) lateSoilCues.SetActive(true);
        }

        public void TryGrip(FirstPersonPullController player)
        {
            if (Harvested || player == null) return;
            if (Vector3.Distance(player.transform.position, transform.position) > gripRange)
            {
                Condition = "Too far - move closer";
                return;
            }

            grippingPlayer = player;
            GripActive = true;
            lastGripPosition = player.transform.position;
            if (mishandledDistance > 0.01f)
            {
                damaged = true;
                Condition = "Recovered grip - root bruised";
            }
            else
            {
                Condition = GrowthStage == "Late" ? "Late grip - high resistance" : "Early grip - light resistance";
            }
        }

        private void ApplyObservedPlayerMotion(Vector3 playerPositionBeforeMove, Vector3 movementDirection, float distance)
        {
            if (!GripActive || Harvested || grippingPlayer == null) return;

            var away = Vector3.ProjectOnPlane(playerPositionBeforeMove - transform.position, Vector3.up).normalized;
            var alignment = Vector3.Dot(movementDirection, away);
            if (alignment >= 0.8f)
            {
                PullProgress = Mathf.Clamp01(PullProgress + distance / RequiredPullDistance);
                Condition = damaged ? "Pulling - bruised root" : (GrowthStage == "Late" ? "Pulling - dense roots holding" : "Pulling - soil releasing");
                rootDeflection = Vector3.Lerp(rootDeflection, Vector3.zero, 0.18f);
                MoveRootedCrop();
                EmitSoilAtMilestone();
                if (PullProgress >= 0.999f) Extract(away);
                return;
            }

            mishandledDistance += distance;
            damaged = true;
            Condition = "Lateral strain - fibers tearing";
            rootDeflection = Vector3.ClampMagnitude(rootDeflection + movementDirection * distance * 0.22f, 0.14f);
            MoveRootedCrop();
            if (mishandledDistance >= 0.14f) ShowDamage();
            EmitSoilAtMilestone();
            if (cropVisual != null)
                cropVisual.localRotation = visualRestRotation * Quaternion.Euler(movementDirection.z * 13f, 0f, -movementDirection.x * 8f);

            if (mishandledDistance >= 0.5f)
            {
                GripActive = false;
                grippingPlayer = null;
                Condition = "Grip slipped - regrip with E";
                ShowDamage();
                if (soilBurst != null) soilBurst.Emit(10);
            }
        }

        private void MoveRootedCrop()
        {
            if (Harvested) return;
            var lift = Mathf.SmoothStep(0f, GrowthStage == "Late" ? 0.28f : 0.34f, PullProgress);
            cropBody.MovePosition(rootedPosition + Vector3.up * lift + rootDeflection);
        }

        private void EmitSoilAtMilestone()
        {
            var effort = PullProgress + mishandledDistance * 0.35f;
            if (soilBurst == null || effort < lastSoilMilestone + 0.055f) return;
            lastSoilMilestone = effort;
            soilBurst.Emit(damaged ? 3 : 2);
        }

        private void ShowDamage()
        {
            if (damageMarks != null) damageMarks.SetActive(true);
            if (bulbRenderer != null && damagedMaterial != null) bulbRenderer.material = damagedMaterial;
        }

        private void UpdateSoilResponse()
        {
            if (soilResponse == null || Harvested) return;
            var effort = Mathf.Clamp01(PullProgress + mishandledDistance * 0.4f);
            soilResponse.localScale = new Vector3(
                soilRestScale.x * (1f + effort * 0.20f),
                soilRestScale.y * (1f - effort * 0.42f),
                soilRestScale.z * (1f + effort * 0.20f));
            var strainYaw = damaged ? Mathf.Sin(feedbackClock * 12f) * 5f : 0f;
            soilResponse.localRotation = soilRestRotation * Quaternion.Euler(0f, strainYaw, 0f);
        }

        public void AcknowledgeResult()
        {
            if (!Harvested || Acknowledged) return;
            Acknowledged = true;
            Condition = damaged ? "ACKNOWLEDGED: bruised by lateral strain" : "ACKNOWLEDGED: intact pull";
            if (nextDecision != null) nextDecision.Reveal(damaged, GrowthStage);
        }

        private void Extract(Vector3 away)
        {
            Harvested = true;
            GripActive = false;
            PullProgress = 1f;
            Condition = damaged
                ? "Harvested bruised - lateral tear visible"
                : (GrowthStage == "Late" ? "Harvested prize-intact - heavy roots" : "Harvested tender-intact - loose soil");

            if (damageMarks != null) damageMarks.SetActive(damaged);
            if (damaged) ShowDamage();
            if (gripLine != null) gripLine.enabled = false;
            if (soilBurst != null) soilBurst.Emit(damaged ? 34 : 26);

            // Pop the result out toward the pulling player before releasing it to
            // physics. It stays close enough to inspect and acknowledge even after
            // the player finishes the sustained movement that caused extraction.
            cropBody.position += Vector3.up * 0.72f + away * 0.45f;
            cropBody.isKinematic = false;
            cropBody.useGravity = true;
            cropBody.mass = GrowthStage == "Late" ? 3.2f : 2.0f;
            var sideways = damaged ? Vector3.forward * 1.6f : Vector3.zero;
            cropBody.AddForce(Vector3.up * 4.2f + away * 2.4f + sideways, ForceMode.Impulse);
            cropBody.AddTorque(damaged ? new Vector3(2f, 0f, 4f) : new Vector3(0f, 0f, 1.2f), ForceMode.Impulse);
        }
    }
}
