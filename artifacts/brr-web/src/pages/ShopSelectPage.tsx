import brrLogo from "@assets/brr_solution_logo_1776622112650.jpeg";
import bgImage from "@assets/brr_liquor_soft_home_page_1780915954544.jpg";
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";

export const SHOPS = ["Balaji", "Jyothi", "Padma", "Mallanna"] as const;
export type ShopName = (typeof SHOPS)[number];

export default function ShopSelectPage() {
  const { user, isLoading } = useAuth();
  const [selectedShop, setSelectedShop] = useState<string>("");
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && user) {
      setLocation(user.role === "admin" ? "/home" : "/sales");
    }
  }, [user, isLoading]);

  const handleContinue = () => {
    if (!selectedShop) return;
    setLocation(`/login?shop=${encodeURIComponent(selectedShop)}`);
  };

  if (isLoading || user) return null;

  return (
    <div
      className="fixed inset-0 flex flex-col overflow-hidden"
      style={{
        backgroundImage: `url(${bgImage})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div className="absolute inset-0 bg-black/25" aria-hidden="true" />

      <div className="relative z-10 flex flex-col items-center w-full h-full overflow-y-auto px-4 py-6 sm:py-8">
        <div className="w-full max-w-xs sm:max-w-sm bg-white/95 backdrop-blur-md rounded-2xl shadow-2xl px-6 sm:px-8 py-7 sm:py-9 flex flex-col items-center gap-5 sm:gap-6">
          <img
            src={brrLogo}
            alt="BRR IT Solutions"
            className="w-16 h-16 sm:w-20 sm:h-20 object-contain rounded-full border-2 border-gray-100 shadow-md flex-shrink-0"
          />

          <div className="text-center">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-800 leading-tight">
              BRR Liquor Soft
            </h1>
            <p className="text-xs sm:text-sm text-gray-500 mt-1">
              Select your shop to continue
            </p>
          </div>

          <div className="w-full flex flex-col gap-3">
            <select
              value={selectedShop}
              onChange={(e) => setSelectedShop(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-gray-300 text-gray-800 bg-white font-medium text-sm focus:outline-none focus:ring-2 focus:ring-red-400/40 focus:border-red-400 shadow-sm"
              data-testid="shop-select"
            >
              <option value="">— Choose a shop —</option>
              {SHOPS.map((shop) => (
                <option key={shop} value={shop}>
                  {shop}
                </option>
              ))}
            </select>

            <button
              disabled={!selectedShop}
              onClick={handleContinue}
              data-testid="shop-continue"
              className="w-full py-3 rounded-xl text-white font-semibold text-sm transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ backgroundColor: "#e03a2f" }}
            >
              Continue →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
