// --- BACKUP OF ODDS SIMULATION LOGIC ---

const workerCode = `
  // --- Worker Code ---
  const probit = (p) => {
      if (p <= 0 || p >= 1) return 0;
      const a1 = -3.969683028665376e+01, a2 = 2.209460984245205e+02,
        a3 = -2.759285104469687e+02, a4 = 1.383577518672690e+02,
        a5 = -3.066479806614716e+01, a6 = 2.506628277459239e+00;
      const b1 = -5.447609879822406e+01, b2 = 1.615858368580409e+02,
        b3 = -1.556989798598866e+02, b4 = 6.680131188771972e+01,
        b5 = -1.328068155288572e+01;
      const c1 = -7.784894002430293e-03, c2 = -3.223964580411365e-01,
        c3 = -2.400758277161838e+00, c4 = -2.549732539343734e+00,
        c5 = 4.374664141464968e+00, c6 = 2.938163982698783e+00;
      const d1 = 7.784695709041462e-03, d2 = 3.224671290700398e-01,
        d3 = 2.445134137142996e+00, d4 = 3.754408661907416e+00;
      const p_low = 0.02425, p_high = 1 - p_low;

      let q, r;
      if (0 < p && p < p_low) {
        q = Math.sqrt(-2 * Math.log(p));
        return (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
          ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
      } else if (p_low <= p && p <= p_high) {
        q = p - 0.5;
        r = q * q;
        return (((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q /
          (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1);
      } else if (p_high < p && p < 1) {
        q = Math.sqrt(-2 * Math.log(1 - p));
        return -(((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
          ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
      }
      return 0;
    };

    // 2. シード付き乱数生成器 (Mulberry32) - ページ更新ごとのブレを防止
    const getSeededRandom = (seed) => {
      return () => {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    };

    // 3. コレスキー分解（リッジ正則化付き）
    const cholesky = (matrix) => {
      const n = matrix.length;
      const L = Array(n).fill(0).map(() => Array(n).fill(0));
      for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
          let sum = 0;
          for (let k = 0; k < j; k++) sum += L[i][k] * L[j][k];
          if (i === j) {
            let val = matrix[i][i] - sum;
            // 半正定値でない場合の安全策（リッジ正則化の代替）
            if (val <= 0) val = 1e-8;
            L[i][j] = Math.sqrt(val);
          } else {
            L[i][j] = (1.0 / L[j][j]) * (matrix[i][j] - sum);
          }
        }
      }
      return L;
    };

    // レース全体のシミュレーション（100000回）と集計
    const simulateRaceData = (horses = []) => {
      const valid = (Array.isArray(horses) ? horses : []).filter(h => h && h.number);
      const N = valid.length;
      if (N === 0) return { frequencies: {}, count: 0 };

      // レースごとのシード値をオッズと馬番から生成（更新ごとのブレを防止）
      let seed = 123456789;
      valid.forEach(h => {
        seed ^= (parseInt(h.number) || 0) * 10000 + Math.floor((parseFloat(h.odds) || 0) * 100);
      });
      const seededRandom = getSeededRandom(seed);

      // ボックス＝ミュラー法による標準正規乱数（シード付き）
      const randn = () => {
        let u = 0, v = 0;
        while (u === 0) u = seededRandom();
        while (v === 0) v = seededRandom();
        return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
      };

      const nums = valid.map(h => String(h.number));
      const oddsArray = valid.map(h => parseFloat(h.odds) || 0);
      const invOddsArray = oddsArray.map(o => o > 0 ? 1 / o : 0);
      const sumInv = invOddsArray.reduce((s, v) => s + v, 0);

      let z = 0;
      if (N === 2) {
        const diffInv = invOddsArray[0] - invOddsArray[1];
        if (sumInv > 0 && diffInv * diffInv !== 1) {
          z = ((sumInv - 1) * (diffInv * diffInv - sumInv)) / (sumInv * (diffInv * diffInv - 1));
        }
      } else if (N > 2 && sumInv > 0) {
        let delta = Infinity;
        let iterations = 0;
        while (delta > 1e-12 && iterations < 1000) {
          const z0 = z;
          let sumSqrt = 0;
          for (let i = 0; i < N; i++) {
            sumSqrt += Math.sqrt(z * z + 4 * (1 - z) * invOddsArray[i] * invOddsArray[i] / sumInv);
          }
          z = (sumSqrt - 2) / (N - 2);
          delta = Math.abs(z - z0);
          iterations++;
        }
      }

      if (isNaN(z) || z < 0 || z >= 1) z = 0;

      // Shinモデルの真の勝率(p_i)と実力スコア(mu_i)の計算
      const pArray = invOddsArray.map(inv => {
        if (sumInv <= 0) return 1 / N;
        if (z === 0) return inv / sumInv;
        return (Math.sqrt(z * z + 4 * (1 - z) * inv * inv / sumInv) - z) / (2 * (1 - z));
      });
      // 確率和を1に正規化（誤差吸収）
      const sumP = pArray.reduce((a, b) => a + b, 0) || 1;
      const normalizedPArray = pArray.map(p => p / sumP);
      const muArray = normalizedPArray.map(p => probit(p));

      // エントロピーと混戦度（Chaos Score）の計算
      let H = 0;
      normalizedPArray.forEach(p => {
        if (p > 0) H -= p * Math.log(p);
      });
      const max_H = Math.log(N);
      const chaos_score = max_H > 0 ? Math.min(1.0, Math.max(0.0, H / max_H)) : 0;
      
      const fav_corr = -0.05 * (1.0 - chaos_score);
      const hole_corr = 0.15 * (1.0 - chaos_score);

      // 相関行列の生成
      const C = Array(N).fill(0).map(() => Array(N).fill(0));
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          if (i === j) {
            C[i][j] = 1.0 + 1e-8; // リッジ正則化
          } else {
            let corr = 0.0;
            const o1 = oddsArray[i], o2 = oddsArray[j];
            if (o1 > 0 && o2 > 0) {
              if (o1 < 5.0 && o2 < 5.0) corr = fav_corr;
              if (o1 >= 50.0 && o2 >= 50.0) corr = hole_corr;
            }
            C[i][j] = corr;
          }
        }
      }

      const L = cholesky(C);
      const SIM_COUNT = 1000000; // ブラウザ同期処理の限界（約1〜2秒）

      // 集計用マップ
      const freq = {
        '単勝': {}, '複勝': {}, '枠連': {}, '馬連': {}, 'ワイド': {}, '馬単': {}, '3連複': {}, '3連単': {}
      };

      for (let sim = 0; sim < SIM_COUNT; sim++) {
        const Z = Array(N).fill(0).map(() => randn());
        const X = Array(N).fill(0);
        for (let i = 0; i < N; i++) {
          for (let j = 0; j <= i; j++) {
            X[i] += L[i][j] * Z[j];
          }
        }

        const results = [];
        for (let i = 0; i < N; i++) {
          results.push({ num: nums[i], score: muArray[i] + X[i], odds: oddsArray[i] });
        }
        // スコアが高い順（1着、2着、3着）にソート
        results.sort((a, b) => b.score - a.score);

        const p1 = results[0].num;
        const p2 = results[1] ? results[1].num : null;
        const p3 = results[2] ? results[2].num : null;

        // 単勝
        freq['単勝'][p1] = (freq['単勝'][p1] || 0) + 1;
        // 複勝
        if (p1) freq['複勝'][p1] = (freq['複勝'][p1] || 0) + 1;
        if (p2) freq['複勝'][p2] = (freq['複勝'][p2] || 0) + 1;
        if (p3) freq['複勝'][p3] = (freq['複勝'][p3] || 0) + 1;

        if (p1 && p2) {
          // 馬単
          const exacta = \`\${p1}-\${p2}\`;

const estimateCombinationOdds = (type, combStr, simData) => {
      if (!simData || simData.count === 0 || !combStr) return null;

      const payoutRate = JRA_PAYOUT_RATE[type] || 0.75;

      let key = combStr.match(/\d+/g);
      if (!key) return null;

      let lookupKey;
      if (type === '単勝' || type === '複勝') {
        lookupKey = key[0];
      } else if (type === '馬連' || type === 'ワイド' || type === '枠連') {
        if (key.length >= 2) lookupKey = [key[0], key[1]].sort((a, b) => parseInt(a) - parseInt(b)).join('-');
      } else if (type === '馬単') {
        if (key.length >= 2) lookupKey = `${key[0]}-${key[1]}`;
      } else if (type === '3連複') {
        if (key.length >= 3) lookupKey = [key[0], key[1], key[2]].sort((a, b) => parseInt(a) - parseInt(b)).join('-');
      } else if (type === '3連単') {
        if (key.length >= 3) lookupKey = `${key[0]}-${key[1]}-${key[2]}`;
      }

      if (!lookupKey) return null;

      const freqMap = simData.frequencies[type === '枠連' ? '馬連' : type] || {};
      const hits = freqMap[lookupKey] || 0;

      // ── ディスカウント・ハーヴィルによる理論確率（事前確率）の算出 ──
      const allProbs = simData.pArrayMap;
      const condProb = (excludeNums, targetNum, c_factor) => {
        const pTarget = allProbs[targetNum];
        if (!pTarget || pTarget <= 0) return 0;
        const pTargetC = Math.pow(pTarget, c_factor);
        let sumC = 0;
        for (const [num, prob] of Object.entries(allProbs)) {
          if (excludeNums.includes(num)) continue;
          sumC += Math.pow(prob, c_factor);
        }
        return sumC > 0 ? pTargetC / sumC : 0;
      };

      const calcHarville = (c_factor) => {
        const n1 = key[0], n2 = key[1], n3 = key[2];
        const p1 = allProbs[n1] || 0.001;
        const p2 = n2 ? (allProbs[n2] || 0.001) : 0;
        let hProb = 0;
        
        if (type === '単勝') {
          hProb = p1;
        } else if (type === '複勝') {
          let probPlace = p1;
          for (const jNum of Object.keys(allProbs)) {
            if (jNum === n1) continue;
            probPlace += allProbs[jNum] * condProb([jNum], n1, c_factor);
            for (const kNum of Object.keys(allProbs)) {
              if (kNum === n1 || kNum === jNum) continue;
              probPlace += allProbs[jNum] * condProb([jNum], kNum, c_factor) * condProb([jNum, kNum], n1, c_factor);
            }
          }
          hProb = Math.min(0.95, probPlace);
        } else if (type === '馬連' || type === '枠連') {
          hProb = p1 * condProb([n1], n2, c_factor) + p2 * condProb([n2], n1, c_factor);
        } else if (type === 'ワイド') {
          const quinella = p1 * condProb([n1], n2, c_factor) + p2 * condProb([n2], n1, c_factor);
          let prob3rd = 0;
          for (const kNum of Object.keys(allProbs)) {
            if (kNum === n1 || kNum === n2) continue;
            prob3rd += allProbs[kNum] * condProb([kNum], n1, c_factor) * condProb([kNum, n1], n2, c_factor);
            prob3rd += allProbs[kNum] * condProb([kNum], n2, c_factor) * condProb([kNum, n2], n1, c_factor);
          }
          hProb = Math.min(0.95, quinella + prob3rd);
        } else if (type === '馬単') {
          hProb = p1 * condProb([n1], n2, c_factor);
        } else if (type === '3連複') {
          const perms = [[n1, n2, n3], [n1, n3, n2], [n2, n1, n3], [n2, n3, n1], [n3, n1, n2], [n3, n2, n1]];
          for (const [a, b, c] of perms) {
            const pa = allProbs[a] || 0.001;
            hProb += pa * condProb([a], b, c_factor) * condProb([a, b], c, c_factor);
          }
        } else if (type === '3連単') {
          hProb = p1 * condProb([n1], n2, c_factor) * condProb([n1, n2], n3, c_factor);
        }
        return hProb;
      };

      const harvilleProb = calcHarville(0.6); // JRAデータセットが訓練されたベースモデル（c=0.6）
      const mcIndepProb = calcHarville(1.0);  // MCシミュレーションの理論ベース（相関なし）

      // ── ベイジアン・スムージング (信頼度ベースのブレンド) ──
      const N_sim = simData.count;
      const K = 5.0 + 15.0 * (simData.chaos_score || 0); 
      const weightSim = hits / (hits + K);

      // MCシミュレーションの推定確率（相関込み）
      let smoothedMcProb = (hits / N_sim) * weightSim + mcIndepProb * (1.0 - weightSim);
      
      // 相関によるブースト（または減少）係数を抽出
      const correlationMultiplier = mcIndepProb > 0 ? smoothedMcProb / mcIndepProb : 1.0;
      
      // 理論確率に、相関ブーストを適用（数学的純粋値）
      let prob = harvilleProb * correlationMultiplier;
      
      let finalOdds = payoutRate / prob;

      // ── 実データセットから抽出した多項式キャリブレーション ──
      // 学術的理論値は、JRA大衆の特殊なFavorite-Longshot Biasと完全に一致しない。
      // 実オッズと理論オッズの差分データから算出した補正曲線（多項式モデル）を適用する。
      if (finalOdds > 50.0) {
        const lnX = Math.log(finalOdds);
        // 実データから導出した予測式 (Degree 2)
        const calibratedOdds = Math.exp(-0.11292498 * (lnX * lnX) + 2.48873704 * lnX - 4.35281205);
        
        // 低オッズ帯でのジャンプを防ぐため、50倍〜150倍の間はシームレスにブレンド
        if (finalOdds <= 150.0) {
          const ratio = (finalOdds - 50.0) / 100.0;
          finalOdds = finalOdds * (1.0 - ratio) + calibratedOdds * ratio;
        } else {
          finalOdds = calibratedOdds;
        }
      }

      return Math.max(1.0, Math.round(finalOdds * 10) / 10);
    };

    // 合成オッズの計算: 全買い目を同時に的中させた場合の期待オッズ
    // = 1 / Σ(1 / 各組み合わせのオッズ)
    
const calculateCompositeOdds = (oddsList = []) => {
      const validOdds = oddsList.filter(o => typeof o === 'number' && o > 0);
      if (validOdds.length === 0) return null;
      const sumInv = validOdds.reduce((sum, o) => sum + (1 / o), 0);
      if (sumInv <= 0) return null;
      const comp = 1 / sumInv;
      return Math.round(comp * 10) / 10;
    };

    
