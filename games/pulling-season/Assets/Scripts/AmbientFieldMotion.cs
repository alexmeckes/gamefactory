using UnityEngine;

namespace PullingSeason
{
    public sealed class AmbientFieldMotion : MonoBehaviour
    {
        [SerializeField] private Transform[] stems;

        private Quaternion[] restRotations;
        private float[] phases;

        public void Configure(Transform[] targetStems)
        {
            stems = targetStems;
        }

        private void Awake()
        {
            if (stems == null) stems = new Transform[0];
            restRotations = new Quaternion[stems.Length];
            phases = new float[stems.Length];
            for (var index = 0; index < stems.Length; index++)
            {
                if (stems[index] != null) restRotations[index] = stems[index].localRotation;
                phases[index] = index * 0.73f;
            }
        }

        private void Update()
        {
            for (var index = 0; index < stems.Length; index++)
            {
                var stem = stems[index];
                if (stem == null) continue;
                var slow = Mathf.Sin(Time.time * 1.15f + phases[index]) * 3.2f;
                var flutter = Mathf.Sin(Time.time * 2.7f + phases[index] * 1.7f) * 1.1f;
                stem.localRotation = restRotations[index] * Quaternion.Euler(slow * 0.35f, flutter, slow);
            }
        }
    }
}

