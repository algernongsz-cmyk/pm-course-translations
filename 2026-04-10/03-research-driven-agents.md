# 研究驱动的Agent：当Agent在编码之前先阅读

> 原文：[Research-Driven Agents: When an agent reads before it codes](https://blog.skypilot.co/research-driven-agents/)  
> 作者：Alex Kim  
> 发布日期：2026年4月8日

**TL;DR：编码Agent在阅读论文和研究竞争项目之后再编写代码时，会产生更好的优化。** 我们向autoresearch / pi-autoresearch循环添加了一个文献搜索阶段，用4个云VM将其指向llama.cpp，在约3小时内产生了5个优化，使flash attention文本生成在x86上快15%，在ARM上快5%（TinyLlama 1.1B）。[完整设置](https://github.com/skypilot-org/skypilot/tree/master/examples/autonomous-code-optimization)适用于任何有benchmark和测试套件的项目。

**关键要点：**

- 在编写代码之前阅读论文和研究竞争项目的Agent会发现仅代码Agent错过的优化。文献研究将Agent指向CUDA/Metal后端中存在但CPU中缺失的算子融合。
- 30多个实验中有5个成功落地：4个kernel融合和一个自适应并行化。最大的收益是将flash attention的QK tile上的三次遍历融合到单个AVX2 FMA循环中。
- 研究fork和其他后端比搜索arxiv更有成效。ik_llama.cpp和CUDA后端直接影响了五个最终优化中的两个。
- 总成本：约$29（$20用于CPU VM，$9用于API调用），在约3小时内使用4个VM。

---

## 仅代码上下文有效的地方

Karpathy的[autoresearch](https://github.com/karpathy/autoresearch)表明，编码Agent可以自主改进神经网络训练脚本。在[我们之前的文章](https://blog.skypilot.co/scaling-autoresearch/)中，我们将其扩展到16个GPU，观察Agent在8小时内运行约910个实验，将`val_bpb`降低2.87%。Agent仅从代码上下文中头脑风暴想法，所有实验都是同一个`train.py`的变体。

从那时起，[pi-autoresearch](https://github.com/davebcn87/pi-autoresearch)将循环泛化为任何可benchmark目标的可重用扩展。Shopify CEO Tobi Lütke在[Liquid](https://github.com/Shopify/liquid/pull/2056)上运行它，这是处理每年2920亿美元商品交易量的Ruby模板引擎。Agent运行了约120个实验，产生了93个提交，将parse+render时间减少了53%，分配减少了61%，在974个单元测试中零回归（[Simon Willison的writeup](https://simonwillison.net/2026/Mar/13/liquid/)，[Tobi的帖子](https://x.com/tobi/status/2032212531846971413)）。

在那种情况下，优化表面在源代码中可见。Liquid Agent可以阅读tokenizer，看到`StringScanner`是瓶颈，并仅从代码库中头脑风暴替代方案。

## 仅代码上下文失效的地方

并非每个优化问题都这样工作。代码库告诉你**代码做什么**，但不告诉你**为什么它慢**或**这个代码库之外存在什么替代方案**。当答案存在于源代码之外（在arxiv论文中，在竞争项目中，例如在高级工程师会带来的领域知识中）时，仅从代码工作的Agent会生成浅薄的假设。

当我们把Agent指向[llama.cpp](https://github.com/ggml-org/llama.cpp)的CPU推理路径时，我们看到了这一点。优化搜索空间不是"尝试不同的学习率"。它是"我应该融合这两个内存遍历吗？"，"这个工作负载是compute-bound还是memory-bound？"，"[ik_llama.cpp](https://github.com/ikawrakow/ik_llama.cpp)已经尝试了什么？"

Agent的第一波实验显示了问题。仅从代码上下文工作，它直接针对GGML矩阵乘法热路径中量化点积的SIMD微优化。它尝试了：

- Q4_0点积内循环中的AVX2预取（+0.8%）
- 带双累加器的2x循环展开（+0.9%）
- 消除`mul_mat`中的临时缓冲区（-2.8%，回归）
- 提升块边界计算（+0.6%）

都在噪音范围内。Agent的事后分析：

> "Wave 1结果表明计算路径中的微优化给予可忽略的回报，因为文本生成是memory-bandwidth bound，不是compute bound。"

606 MiB模型以约49 tokens/s消耗约30 GB/s的内存带宽，接近c6i.2xlarge的DRAM限制。当CPU停滞等待模型权重从DRAM到达时，任何SIMD技巧都无济于事。但代码本身不会告诉你这一点。你需要知道目标硬件的内存带宽，理解roofline模型，并认识到batch-size-1推理是memory-bound。那是Agent没有的领域知识。

## 添加研究阶段

如果瓶颈是假设质量，就给Agent更好的输入。在运行任何实验之前，让它阅读论文，研究fork，并查看其他项目已经尝试了什么。与高级工程师在接触不熟悉的代码之前会做的准备相同。

原始autoresearch循环是：编辑代码 -> 运行实验 -> 检查指标 -> 保留或丢弃。`pi-autoresearch`将其泛化为任何有可benchmark指标的项目。我们的版本在此基础上构建并添加了一个研究步骤和并行云执行：

Agent编写自己的benchmark脚本（`autoresearch.sh`）和正确性检查（`autoresearch.checks.sh`），然后使用[SkyPilot](https://github.com/skypilot-org/skypilot)将实验分发到云VM。每个实验在自己的VM上运行：构建项目，运行benchmark，运行正确性检查，报告指标。Agent通过`sky logs`检查结果，提交胜者，并排队下一波。

<details>
<summary><code>experiment.yaml</code>：单个实验的SkyPilot任务模板</summary>

```yaml
resources:
  cpus: 4+
  memory: 8+

workdir: .

envs:
  EXPERIMENT_ID: baseline
  EXPERIMENT_DESC: "baseline measurement"
  BUILD_CMD: "make -j$(nproc)"
  BENCH_TIMEOUT: 300
  CHECK_TIMEOUT: 300

setup: |
  cd ~/sky_workdir
  if [ -f setup_deps.sh ]; then
    bash setup_deps.sh
  else
    eval "${BUILD_CMD}"
  fi  

run: |
  cd ~/sky_workdir
  # Build, benchmark, run checks, report METRIC lines
  eval "${BUILD_CMD}" 2>&1 | tail -30
  BENCH_OUTPUT=$(timeout "${BENCH_TIMEOUT}" bash autoresearch.sh 2>&1)
  echo "$BENCH_OUTPUT"
  # ... extract METRIC lines, run autoresearch.checks.sh ...
  echo "EXPERIMENT_STATUS: done"
```

CPU绑定代码优化不需要GPU。如果您的目标需要GPU benchmarking，请用`--gpus`覆盖。

</details>

## 实验日志

我们将Claude Code指向llama.cpp，通过SkyPilot给它4个AWS VM，告诉它让CPU推理更快。

**目标：** TinyLlama 1.1B（Q4_0量化）的CPU推理吞吐量，在两种架构上benchmark：

- x86: AWS c6i.2xlarge（Intel Xeon Ice Lake，8 vCPUs，AVX-512）
- ARM: AWS c7g.2xlarge（Graviton3，8 vCPUs，NEON）

**指标：** prompt处理（pp）和文本生成（tg）的tokens/second，用`llama-bench -p 512 -n 128 -t 8 -r 5`测量。

它从4个x86 VM开始建立基线并运行实验。后来它配置ARM VM检查可移植性；每个kernel融合包括AVX2/FMA和NEON路径，带有标量回退。

### 研究发现了什么

在实验波次之间，Agent运行了两个并行研究线程：

1. 竞争项目：ik_llama.cpp（一个专注性能的fork），llamafile的tinyBLAS，PowerInfer，ExLlamaV2（这篇文章的作者甚至不知道其中一些项目）
2. Arxiv论文：[FlashAttention](https://arxiv.org/abs/2205.14135)（IO-aware tiled attention），[Blockbuster](https://arxiv.org/abs/2505.07829)（块级算子融合），[LLM Inference Acceleration via Efficient Operation Fusion](https://arxiv.org/abs/2502.17728)，[Online normalizer calculation for softmax](https://arxiv.org/abs/1805.02867)，[Inference Performance Optimization for Large Language Models on CPUs](https://arxiv.org/abs/2407.07304)（Intel的缓存感知线程分区）

顶级发现：

- ik_llama.cpp的行交错量化重打包给予2.9x PP改进。它已经通过`Q4_0_8x8`重打包格式上游到主线llama.cpp。Agent确认它在benchmark中处于活跃状态。
- [Blockbuster](https://arxiv.org/abs/2505.07829)论文提议将整个FFN块（RMSNorm + gate matmul + up matmul + SwiGLU + down matmul）融合到单个缓存常驻的分块遍历中。Agent尝试实现它，但权重矩阵是量化的（`Q4_0_8x8`），而`ggml_concat`不适用于重打包的量化张量。正确实现需要模型加载器更改。
- Agent检查了c6i.2xlarge的AVX-512支持是否被使用。是的。`-march=native`通过编译器预处理器宏启用它，尽管CMake变量显示`GGML_AVX512=OFF`（这只影响MSVC构建）。
- 合并的gate+up权重（[PR #19139](https://github.com/ggml-org/llama.cpp/pull/19139)）连接gate和up投影权重矩阵，以消除每个FFN块的一个激活加载。这对MoE模型给予+12% PP，但尚未为密集模型实现。

fork分析比arxiv搜索更有用。几个可操作的的想法来自研究ik_llama.cpp和llamafile已经发布的内容。研究CUDA和Metal后端也直接导致了下面的优化#4：Agent注意到RMS_NORM + MUL融合存在于除CPU外的每个后端。

### 转向：从计算到内存

Wave 1失败后，Agent改变了方向：

> "我需要转向减少内存流量或改善内存访问模式的优化。"

Matmul占推理时间的约95%，所以剩余操作（softmax、RMS norm、量化）只留下约5%的余量。但这些操作足够小，是compute-bound而不是memory-bound，所以减少它们内部的内存遍历可以帮助。

### 成功落地的优化

30多个实验中有5个进入了最终代码。每个针对非matmul开销的不同部分：

#### 1. Softmax融合

现有代码在三个单独遍历中执行copy -> scale -> add mask。Agent将它们融合为一个：

```c
// Before: 3 passes
memcpy(wp, sp, nc * sizeof(float));      // pass 1: copy
ggml_vec_scale_f32(nc, wp, scale);        // pass 2: scale
ggml_vec_add_f32(nc, wp, wp, mp_f32);     // pass 3: add mask

// After: 1 pass
for (int i = 0; i < nc; i++) {
    wp[i] = sp[i] * scale + mp_f32[i];
}
```

#### 2. RMS norm融合

相同模式。原来做`memcpy(y, x)`然后`ggml_vec_scale_f32(y, scale)`作为两次遍历。融合为一次遍历的`y[i] = x[i] * scale`。

#### 3. 自适应from_float并行化

`from_float`量化循环（将激活转换为点积输入格式）使用一刀切的并行化策略。现在在有许多行时按行分区（prompt处理），在很少行时按元素分区（文本生成）。

在同一个VM上通过干净的A/B比较验证（没有flash attention，以隔离这三个更改的效果）：

| | pp (tokens/s) | tg (tokens/s) |
|---|---|---|
| Baseline | 210.65 ± 0.64 | 48.90 ± 0.50 |
| Optimized | 215.97 ± 1.52 | 49.33 ± 0.37 |
| Change | **+2.5%** | +0.9% |

文本生成几乎没有变化，如预期：TG是memory-bandwidth bound（如上面Wave 1所述），这些更改不触及matmul路径。Prompt处理获得+2.5%，因为PP是compute-bound，受益于更少的内存遍历。

#### 4. 图级RMS_NORM + MUL融合

这个直接来自研究阶段。在研究其他后端如何处理相同操作时，Agent发现了一个差距：

> "RMS norm + MUL融合不存在于CPU后端，它只在CUDA中。不是做RMS norm（读取x，计算sum，写入y=x*scale）然后MUL（读取y，读取权重，写入y=y*weights），我们在一次遍历中完成：y = x * scale * weights。"

CUDA和Metal后端已经融合这些，但CPU后端没有。Agent不会在没有研究阶段研究其他后端的情况下寻找这个。仅从CPU代码，两步方法看起来很好。

它在CPU图执行循环中实现了模式检测。当它看到`RMS_NORM`后跟`MUL`，其中MUL的输入是RMS_NORM输出时，它调用一个融合kernel，在单个遍历中用显式AVX2和NEON内联函数计算`y = x * (1/sqrt(mean_sq + eps)) * weights`：

```c
// Fused RMS norm + multiply (AVX2 path)
__m256 vscale = _mm256_set1_ps(scale);
for (; i + 7 < ne; i += 8) {
    __m256 vx = _mm256_loadu_ps(x + i);
    __m256 vw = _mm256_loadu_ps(w + i);
    _mm256_storeu_ps(y + i, _mm256_mul_ps(_mm256_mul_ps(vx, vw), vscale));
}
```

第一个版本没有帮助，Agent找出了原因：

> "融合节省了一次内存遍历，但融合的标量循环比原来的SIMD优化单独遍历慢。原代码使用了`memcpy`（高度优化）+ `ggml_vec_scale_f32`（SIMD）+ `binary_op`（SIMD）。我们融合的循环`y[i] = x[i] * scale * w[i]`是标量的，编译器可能不会像那样高效地向量化两次乘法。"

所以它用显式AVX2和NEON内联函数重写了kernel。单独看测量影响在噪音内，但它与flash attention融合叠加并减少TG方差，可能来自更可预测的内存访问模式。

#### 5. Flash attention KQ融合

分块的flash attention路径在QK tile上作为单独遍历执行scale -> pad -> add mask -> find max。Agent将它们融合到单个AVX2 FMA遍历：

```c
// Before: 3 passes over KQ tile
ggml_vec_scale_f32(M, kq, scale);         // pass 1
ggml_vec_add_f32(M, kq, kq, mask_row);    // pass 2
ggml_vec_max_f32(M, &max, kq);            // pass 3

// After: 1 AVX2 FMA pass
__m256 vscale = _mm256_set1_ps(scale);
__m256 vmax = _mm256_set1_ps(-INFINITY);
for (int i = 0; i < M; i += 8) {
    __m256 v = _mm256_fmadd_ps(_mm256_loadu_ps(&kq[i]), vscale,
                                _mm256_loadu_ps(&mask_row[i]));
    _mm256_storeu_ps(&kq[i], v);
    vmax = _mm256_max_ps(vmax, v);
}
```

明确一下：Agent的kernel融合专门针对flash attention分块路径。Flash attention（`-fa 1`）是预先存在的llama.cpp功能，不是Agent发明的。但Agent的融合存在于该代码路径内，所以benchmark需要启用`-fa 1`来执行它们。Agent中途意识到这一点并相应地切换了benchmark。

### 结果

最终比较是苹果对苹果：启用FA的基线 vs 启用FA的优化。两者使用相同标志；区别是融合kernel。通过5次重复的干净A/B构建验证：

**x86，Intel Xeon（c6i.2xlarge，AVX-512）**

| Configuration | pp512 (t/s) | tg128 (t/s) |
|---|---|---|
| Baseline + FA | 241.24 ± 2.24 | 41.37 ± 19.24 |
| **Optimized + FA** | **244.22 ± 1.78** | **47.62 ± 0.59** |
| **Change** | +1.2% | **+15.1%** |

**ARM，Graviton3（c7g.2xlarge，NEON）**

| Configuration | pp512 (t/s) | tg128 (t/s) |
|---|---|---|
| Baseline + FA | 292.99 ± 2.47 | 94.07 ± 19.87 |
| **Optimized + FA** | **298.56 ± 4.28** | **98.77 ± 2.59** |
| **Change** | +1.9% | **+5%** |

TG改进比PP大，因为融合的attention路径在文本生成期间更重要，那里attention是总运行时间的更大比例。方差也值得注意：baseline+FA TG有±19 t/s噪音，而optimized+FA在x86上有±0.59 t/s。融合消除了污染缓存的中间写入，使热路径更可预测。

一个警告：我们在共享租户EC2实例上运行了5次重复。嘈杂的邻居可以在共享硬件上摆动结果（见下面的云VM是嘈杂的）。我们确信方向在两种架构和多个VM上都是真实的，但要相应地对待确切百分比。

我们还没有提交PR。完整的diff在[这里](https://github.com/ggml-org/llama.cpp/compare/master...alex000kim:llama.cpp:autoresearch/cpu-inference-opt?expand=1)。

## 没有工作的东西

### 失败的实验

30多个实验中有25个没有成功。一些代表性失败：

- 带延迟水平求和的SIMD softmax：在`__m256`向量中累加部分和，最后做一次水平归约。0%改进。编译器自动向量化标量循环一样好。
- Flash attention tile size调优：测试了Q=32/KV=128，Q=128/KV=32，Q=32/KV=32。默认64×64已经是最优的。
- 通过`ggml_concat`的合并gate+up matmul：尝试在图构建时连接gate和up权重矩阵以节省一次输入激活加载。崩溃因为`ggml_concat`不支持重打包的量化张量（`Q4_0_8x8`）。正确实现需要模型加载器更改，不是图时操作。
- softmax计算期间的V预取：尝试在计算QK上的softmax时预取V数据。0%改进。硬件预取器已经在处理顺序访问。
- llamafile的sgemm中的冗余加载消除：Q4_0 `load`函数做`denibble + subtract 8`，内循环为同一块调用它3次。Agent缓存了加载的值。0%改进，因为编译器的公共子表达式消除已经处理了它。

一个反复出现的主题：编译器和硬件已经在做许多你会想到手动尝试的事情。没有编译器行为经验，Agent无法预测编译器会处理哪些"优化"。

### benchmark bug

我们的`autoresearch.sh`有一个JSON解析bug，报告文本生成为14 t/s而不是52 t/s。多个实验在错误基线上运行，直到我们捕获它。bug：`llama-bench`输出带有`n_prompt`和`n_gen`字段的JSON，解析脚本在一个不存在的字段名上过滤。

人类也会犯这个错误，但可能会更快注意到不合理低的数字。Agent信任自己的脚本。

### 云VM是嘈杂的

共享硬件上的EC2实例显示运行间高达30%的方差，由于嘈杂的邻居。我们学到这个教训：exp-08显示"+2.1%改进"，结果在重新测量基线时在噪音内。VM-02一直显示比其他更高的方差。

缓解措施：用新的替换嘈杂的VM（新VM通常落在更安静的主机上），使用stddev作为质量信号，只信任stddev <平均值2%的结果。

### 代码审查

在产生优化后，Agent针对llama.cpp的代码库惯例和过去的维护者反馈审查了自己的更改。它在自己的图融合代码中捕获了一个正确性bug：手动的模式检测没有检查中间RMS norm输出在图中是否有其他消费者。如果另一个节点从该输出读取，融合kernel（只写入MUL输出）将使其未初始化。

修复：使用现有的`ggml_can_fuse()`基础设施，它验证使用计数、计算标志、输出标志和视图源链。每个其他后端（CUDA、Metal、Vulkan、OpenCL）已经在使用这个。

## 这对编码Agent意味着什么

标准autoresearch循环（从代码头脑风暴，运行实验，检查指标）在优化表面在源代码中可见时工作。Liquid结果证明了这一点。但对于代码库不包含足够信息来生成好假设的问题，给Agent访问论文和竞争实现会改变它尝试的东西。

llama.cpp上的Wave 1实验都是"让这个循环更快"的变体，当你只有代码作为上下文时你会得到的那种假设。在阅读关于算子融合的论文并研究CUDA/Metal后端如何处理相同操作后，Agent开始问不同的问题："我可以融合这两个操作以消除内存遍历吗？"和"这个模式在其他后端存在但CPU不存在吗？"这些问题导致了优化#4和#5。

这是我们这次运行与我们[之前的GPU autoresearch工作](https://blog.skypilot.co/scaling-autoresearch/)的比较。注意这些针对非常不同的问题（ML训练超参数 vs 编译的C++ kernel），所以数字不能直接比较：

| | [GPU Autoresearch](https://blog.skypilot.co/scaling-autoresearch/) | Literature-Guided Autoresearch |
|---|---|---|
| Target | ML training (karpathy/autoresearch) | 任何OSS项目 |
| Compute | GPU clusters (H100/H200) | CPU VMs（便宜） |
| Search strategy | Agent从代码上下文头脑风暴 | Agent阅读论文 + profile瓶颈 |
| Experiment count | ~910 in 8 hours | 30+ in ~3 hours |
| Experiment cost | ~5 min each（训练运行） | ~5 min each（构建 + benchmark） |
| Total cost | ~$300 (GPU) | ~$20 (CPU VMs) + ~$9 (API) |

实验计数较低，因为每个llama.cpp实验涉及完整的CMake构建（约2 min）加benchmark（约3 min），Agent在波次之间花时间阅读论文和profiling。对于GPU autoresearch，Agent可以每波发射10-13个实验并在5分钟内获得结果。在这里，它每波运行4个实验（每个VM一个），并在波次之间花时间做研究。

## 在你自己的项目上尝试

设置适用于任何有benchmark和测试套件的项目。克隆你的目标，下载两个文件，并将你的编码Agent指向指令：

```bash
# Clone your target project
git clone https://github.com/<org>/<project>.git
cd <project>

# Download the experiment template and agent instructions
curl -fsSL https://raw.githubusercontent.com/skypilot-org/skypilot/master/examples/autonomous-code-optimization/experiment.yaml -o experiment.yaml
curl -fsSL https://raw.githubusercontent.com/skypilot-org/skypilot/master/examples/autonomous-code-optimization/instructions.md -o instructions.md

# Point your coding agent at the instructions
claude "Read instructions.md and optimize <project> for <your metric>."
```

或使用一行设置：

```bash
export TARGET_REPO="https://github.com/<org>/<project>.git"
curl -fsSL https://raw.githubusercontent.com/skypilot-org/skypilot/master/examples/autonomous-code-optimization/setup.sh | bash
```

ML推理框架是好的候选者，因为它们移动快，有清晰的吞吐量指标，新优化机会随着每个主要功能不断出现。一些起点：

| Project | Metric | Literature angle |
|---|---|---|
| [vLLM](https://github.com/vllm-project/vllm) | tokens/s via `benchmark_throughput.py` | PagedAttention调度，前缀缓存，推测解码 |
| [SGLang](https://github.com/sgl-project/sglang) | tokens/s, TTFT | RadixAttention，约束解码，分块预填充 |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | tokens/s via `llama-bench` | 算子融合，量化matmul，缓存高效attention |
| [TensorRT-LLM](https://github.com/NVIDIA/TensorRT-LLM) | tokens/s via `benchmarks/` | Kernel融合，KV缓存优化，in-flight batching |
| [ggml](https://github.com/ggerganov/ggml) | `test-backend-ops` perf | SIMD kernel，量化格式，图优化 |
| [whisper.cpp](https://github.com/ggerganov/whisper.cpp) | real-time factor via `bench` | 推测解码，批量beam search |

我们也尝试了更成熟的项目（Valkey/Redis、PostgreSQL、CPython、SQLite），发现更难发现改进。这些代码库已被数百名贡献者优化了数十年，Agent发现的收益在噪音内。

在YAML中设置`infra:`以针对特定后端（`infra: k8s`用于Kubernetes，`infra: aws`用于AWS等）。

完整设置在[`skypilot/examples/autonomous-code-optimization`](https://github.com/skypilot-org/skypilot/tree/master/examples/autonomous-code-optimization)。

---

*要获取最新更新，请star并watch项目的[GitHub repo](https://github.com/skypilot-org/skypilot/)，follow [@skypilot_org](https://twitter.com/skypilot_org)，或加入[SkyPilot community Slack](https://slack.skypilot.co/)。*