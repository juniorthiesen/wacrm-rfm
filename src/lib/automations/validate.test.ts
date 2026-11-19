import { describe, expect, it } from "vitest";
import { AUTOMATION_TEMPLATES } from "./templates";
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from "./validate";

describe("reativacao_90_dias template", () => {
  const template = AUTOMATION_TEMPLATES.reativacao_90_dias;
  const steps = template.steps;

  it("ships a valid trigger and valid step configs", () => {
    expect(validateTriggerForActivation(template.trigger_type, template.trigger_config)).toEqual([]);
    expect(
      validateStepsForActivation(
        steps.map((s) => ({ step_type: s.step_type, step_config: s.step_config as Record<string, unknown> })),
      ),
    ).toEqual([]);
  });

  it("has a control group and a daily cap by default", () => {
    expect(template.trigger_type).toBe("recency_reached");
    expect(template.trigger_config).toMatchObject({ daily_cap: 100, control_percent: 10 });
  });

  it("puts the coupon and the reminder under the 'no' (did not buy) branch", () => {
    const couponIndex = steps.findIndex((s) => s.step_type === "create_coupon");
    const coupon = steps[couponIndex];
    expect(coupon.branch).toBe("no");
    expect(steps[coupon.parent_index as number].step_type).toBe("condition");

    const reminder = steps[steps.length - 1];
    expect(reminder.branch).toBe("no");
    expect(steps[reminder.parent_index as number].step_type).toBe("condition");
  });

  it("creates the coupon before any e-mail that shows it", () => {
    const couponIndex = steps.findIndex((s) => s.step_type === "create_coupon");
    steps.forEach((s, i) => {
      const cfg = s.step_config as Record<string, unknown>;
      if (s.step_type === "send_email" && String(cfg.coupon_code ?? "").includes("vars.coupon_code")) {
        expect(i).toBeGreaterThan(couponIndex);
      }
    });
  });

  it("every e-mail is marketing with a campaign tag for the report", () => {
    for (const s of steps.filter((x) => x.step_type === "send_email")) {
      const cfg = s.step_config as Record<string, unknown>;
      expect(cfg.category).toBe("marketing");
      expect(String(cfg.campaign_key ?? "")).toMatch(/^reativacao_d\d+$/);
    }
  });
});

describe("carrinho_abandonado_email template", () => {
  const template = AUTOMATION_TEMPLATES.carrinho_abandonado_email;
  const steps = template.steps;
  const asValidatable = (list: typeof steps) =>
    list.map((s) => ({ step_type: s.step_type, step_config: s.step_config as Record<string, unknown> }));

  it("ships a valid trigger and valid step configs", () => {
    expect(template.trigger_type).toBe("cart_abandoned");
    expect(validateTriggerForActivation(template.trigger_type, template.trigger_config)).toEqual([]);
    expect(validateStepsForActivation(asValidatable(steps))).toEqual([]);
  });

  it("sends three marketing e-mails that skip the per-address gap but keep the unsubscribe", () => {
    const emails = steps.filter((s) => s.step_type === "send_email");
    expect(emails).toHaveLength(3);
    for (const s of emails) {
      const cfg = s.step_config as Record<string, unknown>;
      expect(cfg.category).toBe("marketing");
      expect(cfg.respect_min_gap).toBe(false);
      expect(cfg.cta_url).toBe("{{cart.recovery_url}}");
      expect(String(cfg.campaign_key)).toMatch(/^carrinho_d\d$/);
    }
  });

  it("checks for a purchase before every reminder and creates the coupon only before the last one", () => {
    // each e-mail sits under a 'no' branch of a purchase condition
    for (const s of steps.filter((x) => x.step_type === "send_email")) {
      expect(s.branch).toBe("no");
      expect(steps[s.parent_index as number].step_type).toBe("condition");
    }
    const couponIndex = steps.findIndex((s) => s.step_type === "create_coupon");
    const emailsWithCoupon = steps
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => String((s.step_config as Record<string, unknown>).coupon_code ?? "").includes("vars.coupon_code"));
    expect(emailsWithCoupon).toHaveLength(1);
    expect(emailsWithCoupon[0].i).toBeGreaterThan(couponIndex);
    expect((steps[couponIndex].step_config as Record<string, unknown>).discount_type).toBe("percent");
  });

  it("the magic-login template is a transactional e-mail with the login link", () => {
    const magic = AUTOMATION_TEMPLATES.link_magico_email;
    expect(magic.trigger_type).toBe("customer_magic_login_requested");
    expect(validateStepsForActivation(asValidatable(magic.steps))).toEqual([]);
    const cfg = magic.steps[0].step_config as Record<string, unknown>;
    expect(cfg.category).toBe("transactional");
    expect(cfg.cta_url).toBe("{{magic_login.url}}");
  });
});

describe("validateStepsForActivation", () => {
  it("rejects empty or missing step lists", () => {
    expect(validateStepsForActivation([])).toEqual([
      { path: "steps", message: "active automations need at least one step" },
    ]);
    expect(
      validateStepsForActivation(undefined as unknown as never[]),
    ).toEqual([
      { path: "steps", message: "active automations need at least one step" },
    ]);
  });

  it("passes a fully-populated step set", () => {
    const issues = validateStepsForActivation([
      { step_type: "send_message", step_config: { text: "hi" } },
      {
        step_type: "wait",
        step_config: { amount: 5, unit: "minutes" },
      },
      { step_type: "add_tag", step_config: { tag_id: "tag-uuid" } },
      { step_type: "close_conversation", step_config: {} },
    ]);
    expect(issues).toEqual([]);
  });

  it("flags every required field that is missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "send_message", step_config: { text: "  " } },
      { step_type: "send_template", step_config: {} },
      { step_type: "add_tag", step_config: { tag_id: "" } },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].text",
      "steps[1].template_name",
      "steps[2].tag_id",
    ]);
  });

  it("checks wait amount and unit boundaries", () => {
    const issues = validateStepsForActivation([
      { step_type: "wait", step_config: { amount: 0, unit: "minutes" } },
      { step_type: "wait", step_config: { amount: 5, unit: "seconds" } },
      { step_type: "wait", step_config: { amount: -1, unit: "hours" } },
      {
        step_type: "wait",
        step_config: { amount: Number.POSITIVE_INFINITY, unit: "days" },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].amount",
      "steps[1].unit",
      "steps[2].amount",
      "steps[3].amount",
    ]);
  });

  it("validates webhook URLs", () => {
    const good = validateStepsForActivation([
      {
        step_type: "send_webhook",
        step_config: { url: "https://hooks.example.com/in" },
      },
    ]);
    expect(good).toEqual([]);

    const noUrl = validateStepsForActivation([
      { step_type: "send_webhook", step_config: {} },
    ]);
    expect(noUrl.map((i) => i.message)).toContain("webhook URL is required");

    const wrongProtocol = validateStepsForActivation([
      {
        step_type: "send_webhook",
        step_config: { url: "ftp://files.example.com" },
      },
    ]);
    expect(wrongProtocol.map((i) => i.message)).toContain(
      "webhook URL must use http or https",
    );

    const garbage = validateStepsForActivation([
      { step_type: "send_webhook", step_config: { url: "not a url" } },
    ]);
    expect(garbage.map((i) => i.message)).toContain(
      "webhook URL is not a valid URL",
    );
  });

  it("validates assign_conversation only when mode is 'specific'", () => {
    const roundRobinNoAgent = validateStepsForActivation([
      {
        step_type: "assign_conversation",
        step_config: { mode: "round_robin" },
      },
    ]);
    expect(roundRobinNoAgent).toEqual([]);

    const specificMissingAgent = validateStepsForActivation([
      { step_type: "assign_conversation", step_config: { mode: "specific" } },
    ]);
    expect(specificMissingAgent.map((i) => i.path)).toEqual([
      "steps[0].agent_id",
    ]);
  });

  it("flags create_deal when required fields are missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "create_deal", step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      "steps[0].pipeline_id",
      "steps[0].stage_id",
      "steps[0].title",
    ]);
  });

  it("flags update_contact_field when field or value is missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "update_contact_field", step_config: { field: "name" } },
      {
        step_type: "update_contact_field",
        step_config: { field: "", value: "x" },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].value",
      "steps[1].field",
    ]);
  });

  it("recursively walks condition branches with stable dot-paths", () => {
    const issues = validateStepsForActivation([
      {
        step_type: "condition",
        step_config: { subject: "tag", operand: "vip" },
        branches: {
          yes: [{ step_type: "add_tag", step_config: { tag_id: "" } }],
          no: [
            {
              step_type: "send_message",
              step_config: { text: "" },
            },
          ],
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].yes.steps[0].tag_id",
      "steps[0].no.steps[0].text",
    ]);
  });

  it("reports an issue for unknown step types", () => {
    const issues = validateStepsForActivation([
      { step_type: "do_a_barrel_roll", step_config: {} },
    ]);
    expect(issues).toEqual([
      { path: "steps[0]", message: "unknown step type: do_a_barrel_roll" },
    ]);
  });

  it("flags condition subject/operand independently", () => {
    const issues = validateStepsForActivation([
      { step_type: "condition", step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      "steps[0].operand",
      "steps[0].subject",
    ]);
  });
});

describe("validateTriggerForActivation", () => {
  it("accepts a valid keyword_match config", () => {
    expect(
      validateTriggerForActivation("keyword_match", {
        keywords: ["hello", "hi"],
        match_type: "exact",
      }),
    ).toEqual([]);
  });

  it("rejects keyword_match with empty keyword array", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: [],
      match_type: "exact",
    });
    expect(issues.map((i) => i.path)).toContain("trigger.keywords");
  });

  it("rejects keyword_match with whitespace-only entries", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: ["hi", "   "],
      match_type: "contains",
    });
    expect(issues.map((i) => i.message)).toContain(
      "keywords cannot be empty strings",
    );
  });

  it("rejects keyword_match with an unknown match_type", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: ["hi"],
      match_type: "fuzzy",
    });
    expect(issues.map((i) => i.path)).toContain("trigger.match_type");
  });

  it("requires schedule on time_based triggers", () => {
    expect(validateTriggerForActivation("time_based", {})).toEqual([
      { path: "trigger.schedule", message: "schedule is required" },
    ]);
    expect(
      validateTriggerForActivation("time_based", { schedule: "0 9 * * *" }),
    ).toEqual([]);
  });

  it("requires tag_id on tag_added triggers", () => {
    expect(validateTriggerForActivation("tag_added", {})).toEqual([
      { path: "trigger.tag_id", message: "tag is required" },
    ]);
    expect(
      validateTriggerForActivation("tag_added", { tag_id: "tag-uuid" }),
    ).toEqual([]);
  });

  it("does not flag unknown trigger types (handled elsewhere)", () => {
    expect(validateTriggerForActivation("some_future_trigger", {})).toEqual([]);
  });
});

describe("régua pieces: trigger, coupon step and purchase condition", () => {
  const step = (step_type: string, step_config: Record<string, unknown>) =>
    validateStepsForActivation([{ step_type, step_config }]);

  it("validates the recency trigger config", () => {
    expect(validateTriggerForActivation("recency_reached", {})).toEqual([]);
    expect(
      validateTriggerForActivation("recency_reached", { min_days: 90, max_days: 364, daily_cap: 100, control_percent: 10 }),
    ).toEqual([]);
    expect(validateTriggerForActivation("recency_reached", { min_days: 400, max_days: 100 })).toEqual([
      { path: "trigger", message: "max_days must be greater than or equal to min_days" },
    ]);
    expect(validateTriggerForActivation("recency_reached", { control_percent: 99 })).toHaveLength(1);
  });

  it("does not require an operand for purchased_since_enrollment", () => {
    expect(step("condition", { subject: "purchased_since_enrollment" })).toEqual([]);
    expect(step("condition", { subject: "tag_presence" }).map((i) => i.message)).toEqual([
      "condition operand is required",
    ]);
  });

  it("validates the coupon step", () => {
    const ok = { discount_type: "fixed_cart", amount: 20, minimum_amount: 100, valid_days: 10 };
    expect(step("create_coupon", ok)).toEqual([]);
    expect(step("create_coupon", { ...ok, amount: 0 }).map((i) => i.message)).toEqual([
      "coupon amount must be greater than zero",
    ]);
    expect(step("create_coupon", { ...ok, discount_type: "percent", amount: 150 }).map((i) => i.message)).toEqual([
      "percent coupons cannot exceed 100",
    ]);
    expect(step("create_coupon", { ...ok, discount_type: "weird" }).map((i) => i.message)).toEqual([
      "coupon type must be fixed_cart or percent",
    ]);
    expect(step("create_coupon", { ...ok, valid_days: 0 }).map((i) => i.message)).toEqual([
      "coupon validity must be between 1 and 90 days",
    ]);
    expect(step("create_coupon", { ...ok, minimum_amount: -5 }).map((i) => i.message)).toEqual([
      "minimum cart value cannot be negative",
    ]);
  });
});

describe("send_email step validation", () => {
  const ok = {
    subject: "Sentimos sua falta",
    heading: "Sentimos sua falta",
    body: "Oi, {{customer.first_name|linda}}.",
  };
  const issuesFor = (config: Record<string, unknown>) =>
    validateStepsForActivation([{ step_type: "send_email", step_config: config }]);

  it("accepts a minimal valid e-mail step", () => {
    expect(issuesFor(ok)).toEqual([]);
  });

  it("requires subject, heading and body", () => {
    const messages = issuesFor({}).map((i) => i.message);
    expect(messages).toEqual([
      "e-mail subject is required",
      "e-mail heading is required",
      "e-mail body is required",
    ]);
  });

  it("requires button text and URL together", () => {
    expect(issuesFor({ ...ok, cta_label: "Ir" }).map((i) => i.message)).toEqual([
      "button text and URL must be filled together",
    ]);
    expect(issuesFor({ ...ok, cta_url: "https://dly.com.br" }).map((i) => i.message)).toEqual([
      "button text and URL must be filled together",
    ]);
  });

  it("accepts http(s) and {{variable}} URLs, rejects other schemes", () => {
    expect(issuesFor({ ...ok, cta_label: "Ir", cta_url: "https://dly.com.br/x" })).toEqual([]);
    expect(issuesFor({ ...ok, cta_label: "Ir", cta_url: "{{cart.checkout_url}}" })).toEqual([]);
    expect(issuesFor({ ...ok, cta_label: "Ir", cta_url: "javascript:alert(1)" }).map((i) => i.message)).toEqual([
      "button URL must start with http(s):// or a {{variable}}",
    ]);
  });

  it("only allows marketing or transactional as the e-mail type", () => {
    expect(issuesFor({ ...ok, category: "transactional" })).toEqual([]);
    expect(issuesFor({ ...ok, category: "newsletter" }).map((i) => i.message)).toEqual([
      "e-mail type must be marketing or transactional",
    ]);
  });
});
