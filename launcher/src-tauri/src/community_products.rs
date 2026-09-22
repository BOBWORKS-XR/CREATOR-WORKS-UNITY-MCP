//! Optional product metadata never grants package download or import authority.
use super::{text_ok, Listing, Url};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Product {
    pub id: String,
    pub version: String,
    pub purchase_url: String,
    pub website_url: String,
    pub claims: Vec<Claim>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Claim {
    pub dimension: String,
    pub value: String,
    pub evidence: String,
    pub notes: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Index {
    schema_version: u32,
    products: Vec<Product>,
}

pub fn external_url(value: &str) -> bool {
    let authority = value
        .strip_prefix("https://")
        .and_then(|s| s.split('/').next());
    if value.contains('\\')
        || !matches!(
            authority,
            Some("www.patreon.com" | "patreon.com" | "shader.firer.at")
        )
    {
        return false;
    }
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    value.len() <= 2048
        && !value.chars().any(char::is_control)
        && url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && match url.host_str() {
            Some("www.patreon.com" | "patreon.com") => {
                url.path().starts_with("/cw/") && url.path().len() > 4
            }
            Some("shader.firer.at") => true,
            _ => false,
        }
}

pub fn parse(bytes: &[u8], listings: &[Listing]) -> Result<Vec<Product>, String> {
    if bytes.len() > 128 * 1024 {
        return Err("Product metadata exceeds its limit.".into());
    }
    let index: Index = serde_json::from_slice(bytes).map_err(|_| "Invalid product metadata.")?;
    if index.schema_version != 1 || index.products.len() > 50 {
        return Err("Unsupported product metadata.".into());
    }
    let mut keys = HashSet::new();
    for product in &index.products {
        if !text_ok(&product.id, 100)
            || !text_ok(&product.version, 80)
            || !keys.insert((&product.id, &product.version))
            || !external_url(&product.purchase_url)
            || !external_url(&product.website_url)
            || product.claims.len() > 20
        {
            return Err("Invalid product identity or external link.".into());
        }
        for claim in &product.claims {
            if ![
                "unity",
                "creator-sdk",
                "banter-sdk",
                "render-pipeline",
                "host-os",
                "build-target",
                "runtime",
            ]
            .contains(&claim.dimension.as_str())
                || !["author-reported", "maintainer-tested"].contains(&claim.evidence.as_str())
                || !text_ok(&claim.value, 100)
                || !text_ok(&claim.notes, 1000)
            {
                return Err("Invalid compatibility evidence.".into());
            }
        }
    }
    Ok(index
        .products
        .into_iter()
        .filter(|product| {
            listings.iter().any(|entry| {
                entry.id == product.id
                    && entry.version == product.version
                    && entry.review_status == "listed"
                    && entry.scope == "instructions-only"
                    && entry.download.is_none()
            })
        })
        .collect())
}

pub fn action<'a>(
    products: &'a [Product],
    listing: &Listing,
    kind: &str,
) -> Result<&'a str, String> {
    let product = products
        .iter()
        .find(|p| p.id == listing.id && p.version == listing.version)
        .ok_or("No product links available for this listing version.")?;
    let url = match kind {
        "purchase" => &product.purchase_url,
        "product" => &product.website_url,
        _ => return Err("Unknown product action.".into()),
    };
    if !external_url(url) {
        return Err("Unapproved product link.".into());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workshop_candidate_joins_without_changing_legacy_listing_contract() {
        let entry: Listing = serde_json::from_str(include_str!(
            "../../tests/fixtures/community/paid-listing.json"
        ))
        .unwrap();
        entry.validate().unwrap();
        let products = parse(
            include_bytes!("../../tests/fixtures/community/products.json"),
            &[entry.clone()],
        )
        .unwrap();
        assert_eq!(products.len(), 1);
        assert!(products[0]
            .claims
            .iter()
            .all(|claim| claim.evidence == "author-reported"));
        assert_eq!(
            action(&products, &entry, "purchase").unwrap(),
            "https://www.patreon.com/cw/FireRat"
        );
        assert!(!external_url("https://shader.firer.at:443/"));
        assert!(!external_url("https://shader.firer.at\\\\evil"));
    }
    fn listing() -> Listing {
        let mut entry: Listing = serde_json::from_str(include_str!(
            "../../tests/fixtures/community/start-location.json"
        ))
        .unwrap();
        entry.review_status = "listed".into();
        entry.scope = "instructions-only".into();
        entry.download = None;
        entry
    }
    fn fixture(entry: &Listing) -> serde_json::Value {
        serde_json::json!({"schemaVersion":1,"products":[{
            "id":entry.id, "version":entry.version,
            "purchaseUrl":"https://www.patreon.com/cw/FireRat",
            "websiteUrl":"https://shader.firer.at/",
            "claims":[{"dimension":"render-pipeline","value":"URP","evidence":"author-reported","notes":"Author documentation; not independently tested."}]
        }]})
    }
    #[test]
    fn exact_listed_version_only_and_no_download_authority() {
        let entry = listing();
        let bytes = serde_json::to_vec(&fixture(&entry)).unwrap();
        let products = parse(&bytes, &[entry.clone()]).unwrap();
        assert_eq!(products.len(), 1);
        assert!(action(&products, &entry, "purchase")
            .unwrap()
            .contains("patreon.com"));
        assert!(action(&products, &entry, "download").is_err());
        for changed in 0..3 {
            let mut other = entry.clone();
            match changed {
                0 => other.version = "999.0.0".into(),
                1 => other.review_status = "pending".into(),
                _ => other.scope = "runtime".into(),
            }
            assert!(parse(&bytes, &[other]).unwrap().is_empty());
        }
    }
    #[test]
    fn product_links_do_not_expand_package_allowlist() {
        for bad in [
            "http://shader.firer.at/",
            "https://shader.firer.at.evil.test/",
            "https://localhost/",
            "https://127.0.0.1/",
            "https://user@shader.firer.at/",
            "https://shader.firer.at:8443/",
            "https://shader.firer.at/?redirect=x",
            "file:///tmp/test",
        ] {
            assert!(!external_url(bad), "{bad}");
        }
        assert!(!super::super::web_url(
            "https://shader.firer.at/file.unitypackage",
            false
        ));
    }
    #[test]
    fn malformed_metadata_fails_without_mutating_listing() {
        let entry = listing();
        for mode in 0..4 {
            let mut data = fixture(&entry);
            match mode {
                0 => data["schemaVersion"] = 2.into(),
                1 => data["products"][0]["claims"][0]["evidence"] = "verified".into(),
                2 => data["products"][0]["purchaseUrl"] = "javascript:alert(1)".into(),
                _ => {
                    let duplicate = data["products"][0].clone();
                    data["products"].as_array_mut().unwrap().push(duplicate);
                }
            }
            assert!(parse(&serde_json::to_vec(&data).unwrap(), &[entry.clone()]).is_err());
        }
        assert!(entry.download.is_none());
    }
}
