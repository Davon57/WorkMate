# 验证报告

输出简明的中文结论；调用方支持结构化数据时，同时返回等价数据。

```json
{
  "strategy": {
    "framework": null,
    "level": null,
    "reason": "",
    "confidence": 0,
    "evidence": []
  },
  "behaviors": [
    {
      "contract": "Given ... when ... then ...",
      "result": "passed | failed | not_verified | not_automatable",
      "evidence": []
    }
  ],
  "changes": {
    "testFilesAdded": [],
    "testFilesModified": []
  },
  "executions": [
    {
      "command": "",
      "workingDirectory": "",
      "exitCode": null,
      "status": "passed | failed | blocked",
      "durationMs": null,
      "artifacts": []
    }
  ],
  "failures": [],
  "manualChecks": [],
  "conclusion": "verified | partially_verified | failed | blocked"
}
```

可获取时，记录被测试的代码版本。必须区分既有失败、环境阻塞和未观察到的修复前失败。覆盖率只能作为辅助背景，不得决定最终结论。
