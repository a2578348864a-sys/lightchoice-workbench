import { describe, expect, it } from "vitest";

import type { AmazonSearchPageExtraction, AmazonPageContextSignals } from "./extract-search-page";
import { evaluateAmazonSearchPageEnvironment } from "./search-page-environment";

function extraction(priceCurrency: "USD" | "JPY" | null = "USD"): Pick<AmazonSearchPageExtraction, "pageStatus" | "observations"> {
  return {
    pageStatus: "ok",
    observations: [{ priceCurrency } as AmazonSearchPageExtraction["observations"][number]],
  };
}

function signals(deliveryRegion: string | null): AmazonPageContextSignals {
  return {
    pageUrl: "https://www.amazon.com/s?k=desk+organizer&page=2",
    amazonBrandMarkerPresent: true,
    deliveryRegion,
    language: "en-us",
  };
}

describe("Amazon multi-page search environment gate", () => {
  it("accepts a later page only when its own observed environment matches the target market", () => {
    const pageOne = evaluateAmazonSearchPageEnvironment(signals("Delivering to New York 10001"), extraction("USD"));
    const pageTwo = evaluateAmazonSearchPageEnvironment(signals("Delivering to Los Angeles 90017"), extraction("USD"));

    expect(pageOne.status).toBe("passed");
    expect(pageTwo.status).toBe("passed");
    expect(pageTwo.observed.market).toBe("US");
  });

  it("rejects Canada delivery on page two even when the host, language and currency look US", () => {
    const result = evaluateAmazonSearchPageEnvironment(signals("Deliver to Toronto, Canada"), extraction("USD"));

    expect(result.status).toBe("failed");
    expect(result.failedStage).toBe("delivery_verification");
    expect(result.errorCodes).toContain("delivery_region_not_us");
    expect(result.observed.market).toBeNull();
  });

  it("rejects a later page with missing delivery or currency evidence", () => {
    const missingDelivery = evaluateAmazonSearchPageEnvironment(signals(null), extraction("USD"));
    const missingCurrency = evaluateAmazonSearchPageEnvironment(signals("Deliver to 10001"), extraction(null));

    expect(missingDelivery.errorCodes).toContain("delivery_region_not_us");
    expect(missingCurrency.failedStage).toBe("currency_verification");
    expect(missingCurrency.errorCodes).toContain("currency_not_usd");
  });

  it("accepts a US page when some result cards have no visible price but all observed prices are USD", () => {
    const observations = Array.from({ length: 60 }, (_, index) => ({
      priceCurrency: index === 59 ? null : "USD",
    })) as AmazonSearchPageExtraction["observations"];
    const result = evaluateAmazonSearchPageEnvironment(
      signals("Deliver to New York 10001"),
      { pageStatus: "ok", observations },
    );

    expect(result.status).toBe("passed");
    expect(result.observed.currency).toBe("USD");
  });
});
