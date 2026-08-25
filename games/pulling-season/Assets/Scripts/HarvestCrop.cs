using UnityEngine;

namespace PullingSeason
{
    [RequireComponent(typeof(Rigidbody), typeof(Collider))]
    public sealed class HarvestCrop : MonoBehaviour
    {
        // Stable factory observation surface. These members remain public because
        // the immutable v3 scenarios observe them through the running scene.
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
        [SerializeField] private LineRenderer strapLine;
        [SerializeField] private Transform handbar;
        [SerializeField] private Renderer handbarRenderer;
        [SerializeField] private GameObject warningSoil;
        [SerializeField] private GameObject growthPulse;
        [SerializeField] private ParticleSystem soilBurst;
        [SerializeField] private Transform soilResponse;
        [SerializeField] private float gripRange = 2.4f;
        [SerializeField] private float handbarReach = 1.25f;
        [SerializeField] private float slackRadius = 0.82f;
        [SerializeField] private Vector3 releaseDirection = Vector3.left;

        private Rigidbody cropBody;
        private FirstPersonPullController grippingPlayer;
        private Material handbarMaterial;
        private float recoverableStrain;
        private bool damaged;
        private bool damagedAfterHarvest;
        private bool routeCommitted;
        private float previousRouteError;
        private Vector3 currentRouteDirection = Vector3.left;
        private Vector3 visualRestScale;
        private Vector3 visualTargetScale;
        private Quaternion visualRestRotation;
        private Vector3 rootedPosition;
        private Vector3 lastGripPosition;
        private Vector3 soilRestScale;
        private Vector3 soilRestPosition;
        private Quaternion soilRestRotation;
        private Vector3 warningRestScale;
        private float lastSoilMilestone;
        private float feedbackClock;
        private float growthPulseClock;
        private SpringJoint resultGrip;
        private float resultLateralDistance;

        private float RequiredPullDistance => GrowthStage == "Late" ? 1.68f : 1.14f;
        private float RouteTolerance => GrowthStage == "Late" ? 27f : 43f;

        public float Tension01 { get; private set; }
        public float RecoverableStrain => recoverableStrain;
        public float RouteAngleDegrees { get; private set; }
        public bool StrapTaut { get; private set; }
        public string StrapState { get; private set; } = "Slack";
        public bool Damaged => damaged;
        public bool RouteWarning => !Harvested && GripActive && StrapTaut && recoverableStrain >= 0.04f;
        public float PlayerMovementScale => !GripActive || Harvested
            ? 1f
            : (StrapTaut
                ? Mathf.Lerp(GrowthStage == "Late" ? 0.86f : 0.93f, 0.72f, recoverableStrain)
                : 0.96f);

        public void Configure(NextHarvestDecision targetNextDecision, Transform targetVisual, Renderer targetBulbRenderer,
            Material targetEarlyMaterial, Material targetLateMaterial, Material targetDamagedMaterial,
            GameObject targetLateSoilCues, GameObject targetDamageMarks, LineRenderer targetStrapLine,
            Transform targetHandbar, Renderer targetHandbarRenderer, GameObject targetWarningSoil,
            GameObject targetGrowthPulse, ParticleSystem targetSoilBurst, Transform targetSoilResponse)
        {
            nextDecision = targetNextDecision;
            cropVisual = targetVisual;
            bulbRenderer = targetBulbRenderer;
            earlyMaterial = targetEarlyMaterial;
            lateMaterial = targetLateMaterial;
            damagedMaterial = targetDamagedMaterial;
            lateSoilCues = targetLateSoilCues;
            damageMarks = targetDamageMarks;
            strapLine = targetStrapLine;
            handbar = targetHandbar;
            handbarRenderer = targetHandbarRenderer;
            warningSoil = targetWarningSoil;
            growthPulse = targetGrowthPulse;
            soilBurst = targetSoilBurst;
            soilResponse = targetSoilResponse;
        }

        private void Awake()
        {
            cropBody = GetComponent<Rigidbody>();
            cropBody.isKinematic = true;
            cropBody.useGravity = false;
            rootedPosition = cropBody.position;

            releaseDirection = Vector3.ProjectOnPlane(releaseDirection, Vector3.up).normalized;
            if (releaseDirection.sqrMagnitude < 0.5f) releaseDirection = Vector3.left;
            currentRouteDirection = releaseDirection;
            previousRouteError = 0f;

            if (cropVisual != null)
            {
                visualRestScale = cropVisual.localScale;
                visualTargetScale = visualRestScale;
                visualRestRotation = cropVisual.localRotation;
            }

            if (soilResponse != null)
            {
                soilRestScale = soilResponse.localScale;
                soilRestPosition = soilResponse.localPosition;
                soilRestRotation = soilResponse.localRotation;
            }

            if (warningSoil != null)
            {
                warningRestScale = warningSoil.transform.localScale;
                warningSoil.SetActive(false);
            }

            if (lateSoilCues != null) lateSoilCues.SetActive(false);
            if (damageMarks != null) damageMarks.SetActive(false);
            if (growthPulse != null) growthPulse.SetActive(false);
            if (strapLine != null)
            {
                strapLine.positionCount = 4;
                strapLine.useWorldSpace = true;
                strapLine.enabled = true;
            }
            if (handbarRenderer != null) handbarMaterial = handbarRenderer.material;
            UpdateStrapGeometry();
        }

        private void Update()
        {
            feedbackClock += Time.deltaTime;
            UpdateGrowthStep();
            UpdateStrapGeometry();
            UpdateCropResponse();
            UpdateSoilResponse();
        }

        private void LateUpdate()
        {
            if (!GripActive || grippingPlayer == null) return;

            if (handbar != null) handbar.position = grippingPlayer.GripAnchor.position;
            var currentGripPosition = grippingPlayer.transform.position;
            var playerDelta = Vector3.ProjectOnPlane(currentGripPosition - lastGripPosition, Vector3.up);
            var previousGripPosition = lastGripPosition;
            lastGripPosition = currentGripPosition;

            if (playerDelta.sqrMagnitude > 0.000001f)
            {
                if (Harvested)
                    ApplyResultHandling(playerDelta.normalized, playerDelta.magnitude);
                else
                    ApplyObservedPlayerMotion(previousGripPosition, currentGripPosition, playerDelta.magnitude);
            }

            UpdateStrapGeometry();
        }

        public void CommitLate()
        {
            if (Harvested || GripActive || GrowthStage == "Late") return;

            GrowthStage = "Late";
            Condition = "Rooted - crown swelled, roots tightened";
            visualTargetScale = visualRestScale * 1.22f;
            growthPulseClock = 0.85f;

            if (bulbRenderer != null && lateMaterial != null) bulbRenderer.material = lateMaterial;
            if (lateSoilCues != null) lateSoilCues.SetActive(true);
            if (growthPulse != null) growthPulse.SetActive(true);
            if (soilBurst != null) soilBurst.Emit(8);
        }

        public void TryGrip(FirstPersonPullController player)
        {
            if (player == null || Acknowledged) return;
            if (!CanGrip(player))
            {
                Condition = "Strap out of reach";
                return;
            }

            if (Harvested)
            {
                GripExtractedResult(player);
                return;
            }

            grippingPlayer = player;
            GripActive = true;
            lastGripPosition = player.transform.position;
            if (handbar != null) handbar.position = player.GripAnchor.position;

            var newDirection = PlanarDirectionFromRoot(player.transform.position);
            var newError = Vector3.Angle(newDirection, releaseDirection);
            if (routeCommitted && newError + 1f < previousRouteError)
                recoverableStrain = Mathf.Max(0f, recoverableStrain - (previousRouteError - newError) / 58f);
            previousRouteError = newError;
            currentRouteDirection = newDirection;

            Condition = routeCommitted
                ? (recoverableStrain > 0.01f ? "Regripped - route correction held" : "Regripped - line settled")
                : (GrowthStage == "Late" ? "Late strap gripped - dense roots" : "Strap gripped - route the slack");
            UpdateStrapGeometry();
        }

        public bool CanGrip(FirstPersonPullController player)
        {
            if (player == null || Acknowledged) return false;
            var nearCrop = Vector3.Distance(player.transform.position, transform.position) <= gripRange;
            var nearHandbar = handbar != null && Vector3.Distance(player.GripAnchor.position, handbar.position) <= handbarReach;
            return nearCrop || nearHandbar;
        }

        public void ReleaseGrip(FirstPersonPullController player)
        {
            if (player == null || grippingPlayer != player) return;

            if (handbar != null)
            {
                var released = handbar.position;
                released.y = rootedPosition.y + 0.26f;
                handbar.position = released;
            }

            ReleaseExtractedResult();
            Tension01 = 0f;
            StrapTaut = false;
            StrapState = Harvested ? "Result relaxed" : "Unloaded - route retained";
            if (!Harvested)
                Condition = damaged ? "Released - bruising persists" : "Released - route retained";
            UpdateStrapGeometry();
        }

        private void ApplyObservedPlayerMotion(Vector3 beforePosition, Vector3 afterPosition, float distance)
        {
            if (!GripActive || Harvested || grippingPlayer == null) return;

            var beforeFromRoot = Vector3.ProjectOnPlane(beforePosition - rootedPosition, Vector3.up);
            var afterFromRoot = Vector3.ProjectOnPlane(afterPosition - rootedPosition, Vector3.up);
            if (afterFromRoot.sqrMagnitude < 0.0001f) return;

            var afterRadius = afterFromRoot.magnitude;
            var beforeRadius = beforeFromRoot.magnitude;
            var outwardDistance = Mathf.Max(0f, afterRadius - beforeRadius);
            var routeDirection = afterFromRoot / afterRadius;
            var routeError = Vector3.Angle(routeDirection, releaseDirection);
            var improvement = Mathf.Max(0f, previousRouteError - routeError);

            currentRouteDirection = routeDirection;
            RouteAngleDegrees = routeError;
            StrapTaut = afterRadius >= slackRadius;

            if (!StrapTaut)
            {
                StrapState = "Routing slack";
                Tension01 = Mathf.MoveTowards(Tension01, 0f, distance * 2f);
                previousRouteError = routeError;
                Condition = GrowthStage == "Late" ? "Routing around dense soil" : "Routing slack around the seam";
                return;
            }

            if (!routeCommitted)
            {
                routeCommitted = true;
                StrapState = "First taut - route committed";
                Condition = routeError <= RouteTolerance
                    ? "Line taut along the release seam"
                    : "Line taut across resistant roots";
                if (soilBurst != null) soilBurst.Emit(4);
            }

            var routeQuality = 1f - Mathf.Clamp01(routeError / 82f);
            var stretch = Mathf.Clamp01((afterRadius - slackRadius) / 0.74f);
            Tension01 = Mathf.Clamp01((GrowthStage == "Late" ? 0.26f : 0.15f) + stretch * 0.64f + recoverableStrain * 0.25f);

            if (improvement > 0.25f)
            {
                var recovery = improvement / 50f + distance * 0.22f;
                recoverableStrain = Mathf.Max(0f, recoverableStrain - recovery);
                StrapState = recoverableStrain > 0.08f ? "Correcting under load" : "Route recovered";
                Condition = recoverableStrain > 0.08f ? "Strain unwinding - keep correcting" : "Line centered - roots yielding";
            }

            if (outwardDistance > 0.0001f)
            {
                if (routeError <= RouteTolerance)
                {
                    var yieldEfficiency = Mathf.Lerp(0.72f, 1f, routeQuality);
                    PullProgress = Mathf.Clamp01(PullProgress + outwardDistance * yieldEfficiency / RequiredPullDistance);
                    recoverableStrain = Mathf.Max(0f, recoverableStrain - outwardDistance * (GrowthStage == "Late" ? 0.34f : 0.56f));
                    if (recoverableStrain <= 0.08f) StrapState = "Stable load";
                    Condition = damaged
                        ? "Yielding - bruise remains"
                        : (recoverableStrain > 0.08f ? "Yielding while the twist settles" : "Soil releasing along the seam");
                }
                else
                {
                    var error01 = Mathf.InverseLerp(RouteTolerance, 88f, routeError);
                    recoverableStrain = Mathf.Clamp01(recoverableStrain + outwardDistance
                        * Mathf.Lerp(0.48f, GrowthStage == "Late" ? 1.34f : 0.90f, error01));
                    StrapState = "Warning - crossed roots";
                    Condition = "Strap twisting red - sidestep toward the seam";

                    // A merely imperfect line can still make a little headway, but
                    // crossing the roots spends that movement on strain instead.
                    if (error01 < 0.32f)
                        PullProgress = Mathf.Clamp01(PullProgress + outwardDistance * 0.20f / RequiredPullDistance);
                }
            }

            previousRouteError = routeError;
            MoveRootedCrop();
            EmitSoilAtMilestone();

            if (recoverableStrain >= 0.94f && !damaged)
            {
                damaged = true;
                StrapState = "Root torn";
                Condition = "Root fibers torn - bruise will persist";
                ShowDamage();
                if (soilBurst != null) soilBurst.Emit(14);
            }

            if (PullProgress >= 0.999f) Extract(routeDirection);
        }

        private void MoveRootedCrop()
        {
            if (Harvested) return;
            var lift = Mathf.SmoothStep(0f, GrowthStage == "Late" ? 0.27f : 0.34f, PullProgress);
            var lean = currentRouteDirection * (0.035f + Tension01 * 0.095f);
            var shear = Vector3.Cross(Vector3.up, currentRouteDirection) * recoverableStrain * 0.055f;
            cropBody.MovePosition(rootedPosition + Vector3.up * lift + lean + shear);
        }

        private void UpdateGrowthStep()
        {
            if (cropVisual != null && !Harvested)
                cropVisual.localScale = Vector3.Lerp(cropVisual.localScale, visualTargetScale, 1f - Mathf.Exp(-Time.deltaTime * 5.2f));

            if (growthPulseClock <= 0f || growthPulse == null) return;
            growthPulseClock -= Time.deltaTime;
            var phase = 1f - Mathf.Clamp01(growthPulseClock / 0.85f);
            growthPulse.transform.localScale = Vector3.one * Mathf.Lerp(0.65f, 1.65f, phase);
            growthPulse.transform.Rotate(0f, 120f * Time.deltaTime, 0f, Space.Self);
            if (growthPulseClock <= 0f) growthPulse.SetActive(false);
        }

        private void UpdateCropResponse()
        {
            if (cropVisual == null || Harvested) return;

            if (GripActive && StrapTaut)
            {
                var routeLocal = transform.InverseTransformDirection(currentRouteDirection);
                var warningWobble = recoverableStrain > 0.05f
                    ? Mathf.Sin(feedbackClock * Mathf.Lerp(8f, 16f, recoverableStrain)) * recoverableStrain * 7f
                    : 0f;
                var pitch = routeLocal.z * Tension01 * 8f;
                var roll = -routeLocal.x * Tension01 * 9f + warningWobble;
                cropVisual.localRotation = Quaternion.Slerp(cropVisual.localRotation,
                    visualRestRotation * Quaternion.Euler(pitch, 0f, roll), 1f - Mathf.Exp(-Time.deltaTime * 11f));
            }
            else
            {
                cropVisual.localRotation = Quaternion.Slerp(cropVisual.localRotation, visualRestRotation,
                    1f - Mathf.Exp(-Time.deltaTime * 7f));
            }
        }

        private void UpdateStrapGeometry()
        {
            if (strapLine == null || handbar == null) return;

            if (GripActive && grippingPlayer != null) handbar.position = grippingPlayer.GripAnchor.position;
            var cropPoint = transform.position + Vector3.up * (Harvested ? 0.78f : 0.86f);
            var handlePoint = handbar.position;
            var planar = Vector3.ProjectOnPlane(handlePoint - cropPoint, Vector3.up);
            var route = planar.sqrMagnitude > 0.001f ? planar.normalized : currentRouteDirection;
            var perpendicular = Vector3.Cross(Vector3.up, route).normalized;
            var distance = planar.magnitude;
            var taut = GripActive && distance >= slackRadius;
            var guide = cropPoint + route * 0.30f + perpendicular * (taut ? 0.04f : 0.17f);
            guide.y = rootedPosition.y + 0.42f;
            var middle = Vector3.Lerp(guide, handlePoint, 0.54f);
            middle.y -= taut ? 0.03f : Mathf.Lerp(0.24f, 0.08f, Mathf.Clamp01(distance / slackRadius));

            strapLine.SetPosition(0, cropPoint);
            strapLine.SetPosition(1, guide);
            strapLine.SetPosition(2, middle);
            strapLine.SetPosition(3, handlePoint);

            var slackColor = new Color(0.63f, 0.48f, 0.22f);
            var safeColor = new Color(0.98f, 0.78f, 0.24f);
            var warningColor = Color.Lerp(new Color(1f, 0.54f, 0.08f), new Color(0.95f, 0.10f, 0.055f), recoverableStrain);
            var lineColor = RouteWarning || damaged ? warningColor : (taut ? safeColor : slackColor);
            strapLine.startColor = lineColor;
            strapLine.endColor = lineColor;
            if (handbarMaterial != null) handbarMaterial.color = lineColor;

            if (perpendicular.sqrMagnitude > 0.5f)
                handbar.rotation = Quaternion.FromToRotation(Vector3.up, perpendicular);

            if (!GripActive && !Harvested && !routeCommitted) StrapState = "Slack";
        }

        private void EmitSoilAtMilestone()
        {
            var effort = PullProgress + recoverableStrain * 0.32f;
            if (soilBurst == null || effort < lastSoilMilestone + 0.06f) return;
            lastSoilMilestone = effort;
            soilBurst.Emit(RouteWarning || damaged ? 4 : 2);
        }

        private void ShowDamage()
        {
            if (damageMarks != null) damageMarks.SetActive(true);
            if (bulbRenderer != null && damagedMaterial != null) bulbRenderer.material = damagedMaterial;
        }

        private void UpdateSoilResponse()
        {
            if (soilResponse != null && !Harvested)
            {
                var effort = Mathf.Clamp01(PullProgress * 0.82f + Tension01 * 0.18f);
                var lateral = Vector3.Cross(Vector3.up, currentRouteDirection) * recoverableStrain * 0.07f;
                soilResponse.localPosition = soilRestPosition + currentRouteDirection * effort * 0.055f + lateral;
                soilResponse.localScale = new Vector3(
                    soilRestScale.x * (1f + effort * 0.18f),
                    soilRestScale.y * (1f - effort * 0.38f),
                    soilRestScale.z * (1f + effort * 0.18f));
                var routeYaw = Mathf.Atan2(currentRouteDirection.x, currentRouteDirection.z) * Mathf.Rad2Deg;
                var chatter = RouteWarning ? Mathf.Sin(feedbackClock * 17f) * recoverableStrain * 4f : 0f;
                soilResponse.localRotation = soilRestRotation * Quaternion.Euler(0f, routeYaw + chatter, 0f);
            }

            if (warningSoil == null) return;
            var showWarning = RouteWarning && !Harvested;
            warningSoil.SetActive(showWarning);
            if (!showWarning) return;

            var warningTransform = warningSoil.transform;
            warningTransform.position = rootedPosition + currentRouteDirection * 0.58f + Vector3.up * 0.055f;
            warningTransform.rotation = Quaternion.LookRotation(currentRouteDirection, Vector3.up);
            warningTransform.localScale = warningRestScale * (1f + Mathf.Sin(feedbackClock * 13f) * 0.12f);
        }

        public void AcknowledgeResult()
        {
            if (!Harvested || Acknowledged) return;
            ReleaseExtractedResult();
            Acknowledged = true;
            Condition = damaged
                ? (damagedAfterHarvest ? "Acknowledged - bruised during handling" : "Acknowledged - route tear visible")
                : "Acknowledged - intact harvest";
            StrapState = "Result marked - strap relaxed";
            if (nextDecision != null) nextDecision.Reveal(damaged, GrowthStage);
        }

        private void GripExtractedResult(FirstPersonPullController player)
        {
            ReleaseExtractedResult();
            AttachExtractedResult(player);
            Condition = damaged ? "Holding bruised harvest" : "Holding intact harvest - keep it steady";
        }

        private void AttachExtractedResult(FirstPersonPullController player)
        {
            if (player == null) return;
            grippingPlayer = player;
            GripActive = true;
            lastGripPosition = player.transform.position;
            resultLateralDistance = 0f;
            StrapState = "Tethered result";

            resultGrip = gameObject.AddComponent<SpringJoint>();
            resultGrip.connectedBody = player.GetComponent<Rigidbody>();
            resultGrip.autoConfigureConnectedAnchor = false;
            resultGrip.anchor = new Vector3(0f, 0.72f, 0f);
            resultGrip.connectedAnchor = player.transform.InverseTransformPoint(player.GripAnchor.position);
            resultGrip.spring = GrowthStage == "Late" ? 72f : 58f;
            resultGrip.damper = 10f;
            resultGrip.minDistance = 0f;
            resultGrip.maxDistance = 0.24f;
            resultGrip.tolerance = 0.018f;
            resultGrip.enableCollision = false;
        }

        private void ApplyResultHandling(Vector3 movementDirection, float distance)
        {
            if (resultGrip == null || grippingPlayer == null || Acknowledged) return;

            var handForward = Vector3.ProjectOnPlane(grippingPlayer.GripAnchor.forward, Vector3.up).normalized;
            var straightness = Mathf.Abs(Vector3.Dot(movementDirection, handForward));
            if (straightness >= 0.72f)
            {
                resultLateralDistance = Mathf.Max(0f, resultLateralDistance - distance * 0.45f);
                Condition = damaged ? "Carrying bruised harvest" : "Carrying intact harvest - steady";
                return;
            }

            resultLateralDistance += distance;
            Condition = "Harvest swinging - straighten the carry";
            if (resultLateralDistance < 0.18f || damagedAfterHarvest) return;

            damaged = true;
            damagedAfterHarvest = true;
            Condition = "Harvest bruised by sideways handling";
            ShowDamage();
            if (soilBurst != null) soilBurst.Emit(8);
            cropBody.AddTorque(new Vector3(movementDirection.z * 2.1f, 0f, -movementDirection.x * 2.1f), ForceMode.Impulse);
        }

        private void ReleaseExtractedResult()
        {
            GripActive = false;
            grippingPlayer = null;
            if (resultGrip == null) return;
            resultGrip.spring = 0f;
            resultGrip.connectedBody = null;
            Destroy(resultGrip);
            resultGrip = null;
        }

        private void Extract(Vector3 routeDirection)
        {
            var player = grippingPlayer;
            Harvested = true;
            Tension01 = 0f;
            PullProgress = 1f;
            recoverableStrain = Mathf.Min(recoverableStrain, 0.93f);
            StrapTaut = true;
            Condition = damaged
                ? "Harvested bruised - crossed roots tore visibly"
                : (GrowthStage == "Late" ? "Harvested heavy and intact" : "Harvested tender and intact");

            if (warningSoil != null) warningSoil.SetActive(false);
            if (damageMarks != null) damageMarks.SetActive(damaged);
            if (damaged) ShowDamage();
            if (soilBurst != null) soilBurst.Emit(damaged ? 34 : 26);

            cropBody.position += Vector3.up * 0.68f + routeDirection * 0.34f;
            cropBody.isKinematic = false;
            cropBody.useGravity = true;
            cropBody.mass = GrowthStage == "Late" ? 3.25f : 2.0f;
            cropBody.AddForce(Vector3.up * 2.8f + routeDirection * 1.45f, ForceMode.Impulse);
            cropBody.AddTorque(damaged ? new Vector3(2f, 0f, 3.6f) : new Vector3(0f, 0f, 0.9f), ForceMode.Impulse);

            AttachExtractedResult(player);
        }

        private Vector3 PlanarDirectionFromRoot(Vector3 worldPosition)
        {
            var direction = Vector3.ProjectOnPlane(worldPosition - rootedPosition, Vector3.up);
            return direction.sqrMagnitude > 0.0001f ? direction.normalized : releaseDirection;
        }
    }
}
