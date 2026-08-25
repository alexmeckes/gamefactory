using UnityEngine;
using UnityEngine.InputSystem;

namespace PullingSeason
{
    [RequireComponent(typeof(Rigidbody), typeof(CapsuleCollider))]
    public sealed class FirstPersonPullController : MonoBehaviour
    {
        [SerializeField] private HarvestCrop crop;
        [SerializeField] private Transform cameraRig;
        [SerializeField] private Transform leftHand;
        [SerializeField] private Transform rightHand;
        [SerializeField] private Transform gripAnchor;
        [SerializeField] private float movementSpeed = 2.35f;
        [SerializeField] private float mouseSensitivity = 0.095f;
        [SerializeField] private float rootedCropClearance = 1.25f;

        private Rigidbody body;
        private Vector3 cameraRest;
        private Vector3 leftRest;
        private Vector3 rightRest;
        private float motionClock;
        private float yaw;
        private float pitch;

        public Transform GripAnchor => gripAnchor != null ? gripAnchor : transform;
        public bool IsNearCrop => crop != null && crop.CanGrip(this);

        public void Configure(HarvestCrop targetCrop, Transform targetCameraRig, Transform targetLeftHand,
            Transform targetRightHand, Transform targetGripAnchor)
        {
            crop = targetCrop;
            cameraRig = targetCameraRig;
            leftHand = targetLeftHand;
            rightHand = targetRightHand;
            gripAnchor = targetGripAnchor;
        }

        private void Awake()
        {
            body = GetComponent<Rigidbody>();
            body.isKinematic = true;
            body.useGravity = false;
            body.interpolation = RigidbodyInterpolation.None;
            body.collisionDetectionMode = CollisionDetectionMode.ContinuousSpeculative;
            if (cameraRig != null) cameraRest = cameraRig.localPosition;
            if (leftHand != null) leftRest = leftHand.localPosition;
            if (rightHand != null) rightRest = rightHand.localPosition;

            yaw = cameraRig != null ? cameraRig.localEulerAngles.y : transform.eulerAngles.y;
            transform.rotation = Quaternion.Euler(0f, yaw, 0f);
            if (cameraRig != null) cameraRig.localRotation = Quaternion.identity;
            Cursor.lockState = CursorLockMode.Locked;
            Cursor.visible = false;
        }

        private void Update()
        {
            var keyboard = Keyboard.current;
            var mouse = Mouse.current;
            if (keyboard == null || crop == null) return;

            if (keyboard.escapeKey.wasPressedThisFrame)
            {
                Cursor.lockState = CursorLockMode.None;
                Cursor.visible = true;
            }
            else if (mouse != null && mouse.leftButton.wasPressedThisFrame && Cursor.lockState != CursorLockMode.Locked)
            {
                Cursor.lockState = CursorLockMode.Locked;
                Cursor.visible = false;
            }

            UpdateLook(mouse);

            if (mouse != null && mouse.rightButton.wasPressedThisFrame) crop.CommitLate();
            if (mouse != null && mouse.leftButton.wasPressedThisFrame) crop.TryGrip(this);
            if (mouse != null && mouse.leftButton.wasReleasedThisFrame) crop.ReleaseGrip(this);
            if (keyboard.spaceKey.wasPressedThisFrame) crop.AcknowledgeResult();

            var input = Vector2.zero;
            if (keyboard.dKey.isPressed) input.x += 1f;
            if (keyboard.aKey.isPressed) input.x -= 1f;
            if (keyboard.wKey.isPressed) input.y += 1f;
            if (keyboard.sKey.isPressed) input.y -= 1f;

            var movement = transform.right * input.x + transform.forward * input.y;
            var moving = movement.sqrMagnitude > 0.01f;
            if (moving)
            {
                movement.Normalize();
                var acceptedPosition = body.position;
                var speedScale = crop.PlayerMovementScale;
                var nextPosition = acceptedPosition + movement * movementSpeed * speedScale * Time.deltaTime;
                nextPosition = PreventRootedCropOverlap(acceptedPosition, nextPosition);

                body.position = nextPosition;
                transform.position = nextPosition;
                motionClock += Time.deltaTime * Mathf.Lerp(8.5f, 5.8f, 1f - speedScale);
            }

            AnimateEmbodiment(moving);
        }

        private Vector3 PreventRootedCropOverlap(Vector3 acceptedPosition, Vector3 nextPosition)
        {
            if (crop == null || crop.Harvested || rootedCropClearance <= 0f) return nextPosition;

            var root = crop.transform.position;
            var planarOffset = Vector3.ProjectOnPlane(nextPosition - root, Vector3.up);
            if (planarOffset.sqrMagnitude >= rootedCropClearance * rootedCropClearance) return nextPosition;

            var approachDirection = planarOffset.normalized;
            if (approachDirection.sqrMagnitude < 0.5f)
                approachDirection = Vector3.ProjectOnPlane(acceptedPosition - root, Vector3.up).normalized;
            if (approachDirection.sqrMagnitude < 0.5f) approachDirection = -transform.forward;

            var resolved = root + approachDirection * rootedCropClearance;
            resolved.y = nextPosition.y;
            return resolved;
        }

        private void UpdateLook(Mouse mouse)
        {
            if (mouse != null && cameraRig != null && Cursor.lockState == CursorLockMode.Locked)
            {
                var delta = mouse.delta.ReadValue();
                yaw += delta.x * mouseSensitivity;
                pitch = Mathf.Clamp(pitch - delta.y * mouseSensitivity, -62f, 58f);
                transform.rotation = Quaternion.Euler(0f, yaw, 0f);
            }
        }

        private void AnimateEmbodiment(bool moving)
        {
            var gripping = crop != null && crop.GripActive;
            var taut = gripping && crop.StrapTaut;
            var strain = gripping ? crop.RecoverableStrain : 0f;
            var load = gripping ? crop.Tension01 : 0f;
            var bob = moving ? Mathf.Sin(motionClock) * Mathf.Lerp(0.018f, 0.009f, load) : 0f;
            var warningShake = strain > 0.05f ? Mathf.Sin(Time.time * 18f) * strain : 0f;

            if (cameraRig != null)
            {
                var loadSet = taut ? new Vector3(0f, -load * 0.028f, -load * 0.035f) : Vector3.zero;
                cameraRig.localPosition = Vector3.Lerp(cameraRig.localPosition,
                    cameraRest + Vector3.up * bob + loadSet + Vector3.right * warningShake * 0.008f, 0.22f);
                cameraRig.localRotation = Quaternion.Euler(pitch + load * 1.1f, 0f, warningShake * 0.75f);
            }

            var handLag = taut ? load * 0.045f : 0f;
            if (leftHand != null)
            {
                var target = gripping
                    ? new Vector3(-0.13f - strain * 0.025f, -0.17f, 0.64f + bob + handLag)
                    : leftRest + Vector3.up * bob;
                leftHand.localPosition = Vector3.Lerp(leftHand.localPosition, target, 0.2f);
                leftHand.localRotation = Quaternion.Euler(gripping
                    ? new Vector3(18f + load * 8f, -8f, -18f - strain * 9f)
                    : new Vector3(8f, 0f, -8f));
            }

            if (rightHand != null)
            {
                var target = gripping
                    ? new Vector3(0.13f + strain * 0.025f, -0.17f, 0.64f - bob + handLag)
                    : rightRest - Vector3.up * bob;
                rightHand.localPosition = Vector3.Lerp(rightHand.localPosition, target, 0.2f);
                rightHand.localRotation = Quaternion.Euler(gripping
                    ? new Vector3(18f + load * 8f, 8f, 18f + strain * 9f)
                    : new Vector3(8f, 0f, 8f));
            }
        }
    }
}
