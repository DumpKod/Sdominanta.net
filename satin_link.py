import json
import numpy as np
import matplotlib.pyplot as plt


def main() -> int:
    # Demo: use F18 C_se = exp(-2 n_se(T)/N), with n_se=γ_q T, choose N=1 for scale
    N = 1.0
    gamma_q_true = 0.8
    T = np.linspace(0.0, 1.0, 101)
    C_se = np.exp(-2.0 * (gamma_q_true * T) / N)

    # Estimate γ_q from F0.7: γ_q = - (N/2) d/dT ln C_se(T)
    # Finite differences
    dlnC_dT = np.gradient(np.log(np.clip(C_se, 1e-9, 1.0)), T)
    gamma_q_est = - (N / 2.0) * dlnC_dT

    fig, ax = plt.subplots(1, 2, figsize=(9, 4), dpi=160)
    ax[0].plot(T, C_se, label='C_se(T)')
    ax[0].set_xlabel('T')
    ax[0].set_ylabel('C_se')
    ax[0].set_title('SATIN contrast C_se(T) (F18)')
    ax[0].grid(True, alpha=0.2)

    ax[1].plot(T, gamma_q_est, label=r'γ_q(T) estimate')
    ax[1].axhline(gamma_q_true, color='k', ls='--', lw=1, label='true γ_q')
    ax[1].set_xlabel('T')
    ax[1].set_ylabel(r'γ_q')
    ax[1].set_title(r'γ_q from C_se(T) via F0.7')
    ax[1].legend()
    ax[1].grid(True, alpha=0.2)

    fig.tight_layout()
    fig.savefig('satin_link.png')
    print('Saved satin_link.png')

    out = {
        "gamma_q_true": gamma_q_true,
        "gamma_q_est_mean": float(np.mean(gamma_q_est[5:-5])),  # avoid edge effects
        "gamma_q_est_std": float(np.std(gamma_q_est[5:-5], ddof=1)),
    }
    with open('gamma_q_fit.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print('Saved gamma_q_fit.json')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())


