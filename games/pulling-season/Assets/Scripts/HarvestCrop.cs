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
        [SerializeField] private float gripRange = 2.4f;

        private Rigidbody cropBody;
        private FirstPersonPullController grippingPlayer;
        private float mishandledDistance;
        private bool damaged;
        private Vector3 visualRestScale;
        private Quaternion visualRestRotation;
        private float feedbackClock;

        private float RequiredPullDistance => GrowthStage == "Late" ? 2.55f : 1.75f;

        public void Configure(NextHarvestDecision targetNextDecision, Transform targetVisual, Renderer targetBulbRenderer,
            Material targetEarlyMaterial, Material targetLateMaterial, Material targetDamagedMaterial,
            GameObject targetLateSoilCues, GameObject targetDamageMarks, LineRenderer targetGripLine, ParticleSystem targetSoilBurst)
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
        }

        private void Awake()
        {
            cropBody = GetComponent<Rigidbody>();
            cropBody.isKinematic = true;
            cropBody.useGravity = false;
            if (cropVisual != null)
            {
                visualRestScale = cropVisual.localScale;
                visualRestRotation = cropVisual.localRotation;
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
                var tension = GripActive ? 2.5f + PullProgress * 5f : 1.2f;
                var wobble = Mathf.Sin(feedbackClock * tension) * (GripActive ? 3f + PullProgress * 7f : 0.7f);
                cropVisual.localRotation = visualRestRotation * Quaternion.Euler(0f, 0f, wobble);
            }
        }

        public void CommitLate()
        {
            if (Harvested || GrowthStage == "Late") return;
            GrowthStage = "Late";
            Condition = "Rooted - dense roots";
            if (cropVisual != null)
            {
                cropVisual.localScale = visualRestScale * 1.2f;
                visualRestScale = cropVisual.localScale;
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

        public void ApplyPlayerMovement(Vector3 playerPositionBeforeMove, Vector3 movementDirection, float distance)
        {
            if (!GripActive || Harvested || grippingPlayer == null) return;

            var away = Vector3.ProjectOnPlane(playerPositionBeforeMove - transform.position, Vector3.up).normalized;
            var alignment = Vector3.Dot(movementDirection, away);
            if (alignment >= 0.8f)
            {
                PullProgress = Mathf.Clamp01(PullProgress + distance / RequiredPullDistance);
                Condition = damaged ? "Pulling - bruised root" : (GrowthStage == "Late" ? "Pulling - dense roots holding" : "Pulling - soil releasing");
                if (soilBurst != null && !soilBurst.isPlaying) soilBurst.Play();
                if (PullProgress >= 0.999f) Extract(away);
                return;
            }

            mishandledDistance += distance;
            damaged = true;
            Condition = "Lateral strain - fibers tearing";
            if (cropVisual != null)
                cropVisual.localRotation = visualRestRotation * Quaternion.Euler(movementDirection.z * 13f, 0f, -movementDirection.x * 8f);

            if (mishandledDistance >= 0.5f)
            {
                GripActive = false;
                grippingPlayer = null;
                Condition = "Grip slipped - regrip with E";
            }
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
            if (damaged && bulbRenderer != null && damagedMaterial != null) bulbRenderer.material = damagedMaterial;
            if (gripLine != null) gripLine.enabled = false;
            if (soilBurst != null) soilBurst.Play();

            transform.position += Vector3.up * 0.72f;
            cropBody.isKinematic = false;
            cropBody.useGravity = true;
            cropBody.mass = GrowthStage == "Late" ? 3.2f : 2.0f;
            var sideways = damaged ? Vector3.forward * 1.6f : Vector3.zero;
            cropBody.AddForce(Vector3.up * 4.2f + away * 1.6f + sideways, ForceMode.Impulse);
            cropBody.AddTorque(damaged ? new Vector3(2f, 0f, 4f) : new Vector3(0f, 0f, 1.2f), ForceMode.Impulse);
        }
    }
}
