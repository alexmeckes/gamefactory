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

        private Rigidbody body;
        private Vector3 cameraRest;
        private Vector3 leftRest;
        private Vector3 rightRest;
        private float motionClock;
        private float yaw;
        private float pitch;
        private bool keyboardGripLatched;

        public Transform GripAnchor => gripAnchor != null ? gripAnchor : transform;
        public bool IsNearCrop => crop != null && crop.CanGrip(this);

        public void Configure(HarvestCrop targetCrop, Transform targetCameraRig, Transform targetLeftHand, Transform targetRightHand, Transform targetGripAnchor)
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
            // Input is consumed and evidenced from the visible pose in Update.
            // Interpolation can leave the Transform one physics pose behind.
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

            if (mouse != null && mouse.leftButton.wasPressedThisFrame) crop.TryGrip(this);
            if (mouse != null && mouse.leftButton.wasReleasedThisFrame) crop.ReleaseGrip(this);
            if (keyboard.eKey.wasPressedThisFrame)
            {
                keyboardGripLatched = !keyboardGripLatched;
                if (keyboardGripLatched) crop.TryGrip(this);
                else crop.ReleaseGrip(this);
            }
            if (keyboard.gKey.wasPressedThisFrame) crop.CommitLate();
            if (keyboard.spaceKey.wasPressedThisFrame) crop.AcknowledgeResult();

            var input = Vector2.zero;
            if (keyboard.dKey.isPressed) input.x += 1f;
            if (keyboard.aKey.isPressed) input.x -= 1f;
            if (keyboard.wKey.isPressed) input.y += 1f;
            if (keyboard.sKey.isPressed) input.y -= 1f;

            var movement = transform.right * input.x + transform.forward * input.y;

            if (movement.sqrMagnitude > 0.01f)
            {
                movement.Normalize();
                // Rebase every move on the pose Unity actually accepted. If a
                // collision blocks one axis, later corrective input must be able to
                // move along or away from the obstacle instead of repeatedly aiming
                // at the same unreachable cached position.
                var acceptedPosition = body.position;
                var nextPosition = acceptedPosition + movement * movementSpeed * Time.deltaTime;

                body.position = nextPosition;
                transform.position = nextPosition;
                motionClock += 0.28f;
            }

            AnimateEmbodiment(movement.sqrMagnitude > 0.01f);
        }

        private void UpdateLook(Mouse mouse)
        {
            if (mouse == null || cameraRig == null || Cursor.lockState != CursorLockMode.Locked) return;

            var delta = mouse.delta.ReadValue();
            yaw += delta.x * mouseSensitivity;
            pitch = Mathf.Clamp(pitch - delta.y * mouseSensitivity, -62f, 58f);
            transform.rotation = Quaternion.Euler(0f, yaw, 0f);
            cameraRig.localRotation = Quaternion.Euler(pitch, 0f, 0f);
        }

        private void AnimateEmbodiment(bool moving)
        {
            var gripping = crop != null && crop.GripActive;
            var bob = moving ? Mathf.Sin(motionClock) * 0.018f : 0f;
            if (cameraRig != null)
                cameraRig.localPosition = Vector3.Lerp(cameraRig.localPosition, cameraRest + Vector3.up * bob, 0.22f);

            if (leftHand != null)
            {
                var target = gripping ? new Vector3(-0.13f, -0.17f, 0.64f + bob) : leftRest + Vector3.up * bob;
                leftHand.localPosition = Vector3.Lerp(leftHand.localPosition, target, 0.2f);
                leftHand.localRotation = Quaternion.Euler(gripping ? new Vector3(18f, -8f, -18f) : new Vector3(8f, 0f, -8f));
            }

            if (rightHand != null)
            {
                var target = gripping ? new Vector3(0.13f, -0.17f, 0.64f - bob) : rightRest - Vector3.up * bob;
                rightHand.localPosition = Vector3.Lerp(rightHand.localPosition, target, 0.2f);
                rightHand.localRotation = Quaternion.Euler(gripping ? new Vector3(18f, 8f, 18f) : new Vector3(8f, 0f, 8f));
            }
        }
    }
}
