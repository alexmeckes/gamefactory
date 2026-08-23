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
        [SerializeField] private float distancePerFrame = 0.02f;

        private Rigidbody body;
        private Vector3 cameraRest;
        private Vector3 leftRest;
        private Vector3 rightRest;
        private float motionClock;

        public Transform GripAnchor => gripAnchor != null ? gripAnchor : transform;

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
            if (cameraRig != null) cameraRest = cameraRig.localPosition;
            if (leftHand != null) leftRest = leftHand.localPosition;
            if (rightHand != null) rightRest = rightHand.localPosition;
        }

        private void Update()
        {
            var keyboard = Keyboard.current;
            if (keyboard == null || crop == null) return;

            if (keyboard.gKey.wasPressedThisFrame) crop.CommitLate();
            if (keyboard.eKey.wasPressedThisFrame) crop.TryGrip(this);
            if (keyboard.spaceKey.wasPressedThisFrame) crop.AcknowledgeResult();

            var movement = Vector3.zero;
            if (keyboard.dKey.isPressed) movement += Vector3.right;
            if (keyboard.aKey.isPressed) movement += Vector3.left;
            if (keyboard.wKey.isPressed) movement += Vector3.forward;
            if (keyboard.sKey.isPressed) movement += Vector3.back;

            if (movement.sqrMagnitude > 0.01f && !crop.Harvested)
            {
                movement.Normalize();
                var before = transform.position;
                var after = before + movement * distancePerFrame;
                body.position = after;
                transform.position = after;
                crop.ApplyPlayerMovement(before, movement, distancePerFrame);
                motionClock += 0.28f;
            }

            AnimateEmbodiment(movement.sqrMagnitude > 0.01f);
        }

        private void AnimateEmbodiment(bool moving)
        {
            var gripping = crop != null && crop.GripActive && !crop.Harvested;
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
