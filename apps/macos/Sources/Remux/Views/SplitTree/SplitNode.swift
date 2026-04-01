import Foundation

/// Recursive binary tree for split pane layout.
/// Adapted from ghostty-org/ghostty SplitNode design pattern.
indirect enum SplitNode: Identifiable, Sendable {
    case leaf(LeafData)
    case branch(BranchData)

    struct LeafData: Identifiable, Sendable {
        var id: UUID
        var tabIndex: Int
        var panelType: PanelType

        init(id: UUID = UUID(), tabIndex: Int, panelType: PanelType = .terminal) {
            self.id = id
            self.tabIndex = tabIndex
            self.panelType = panelType
        }
    }

    struct BranchData: Identifiable, Sendable {
        var id: UUID
        var orientation: Orientation
        var ratio: CGFloat
        var first: SplitNode
        var second: SplitNode

        init(
            id: UUID = UUID(),
            orientation: Orientation,
            ratio: CGFloat = 0.5,
            first: SplitNode,
            second: SplitNode
        ) {
            self.id = id
            self.orientation = orientation
            self.ratio = ratio
            self.first = first
            self.second = second
        }
    }

    enum Orientation: String, Sendable, Codable {
        case horizontal  // side by side (split right)
        case vertical    // top and bottom (split down)
    }

    var id: UUID {
        switch self {
        case .leaf(let data): data.id
        case .branch(let data): data.id
        }
    }

    // MARK: - Tree operations

    /// Find a leaf by its ID.
    func findLeaf(id: UUID) -> LeafData? {
        switch self {
        case .leaf(let data):
            return data.id == id ? data : nil
        case .branch(let data):
            return data.first.findLeaf(id: id) ?? data.second.findLeaf(id: id)
        }
    }

    /// Collect all leaf nodes in order.
    var allLeaves: [LeafData] {
        switch self {
        case .leaf(let data):
            return [data]
        case .branch(let data):
            return data.first.allLeaves + data.second.allLeaves
        }
    }

    /// Split a leaf node into a branch with the original leaf and a new leaf.
    func split(leafID: UUID, orientation: Orientation, newTabIndex: Int, panelType: PanelType = .terminal) -> SplitNode {
        switch self {
        case .leaf(let data):
            guard data.id == leafID else { return self }
            let newLeaf = SplitNode.leaf(LeafData(tabIndex: newTabIndex, panelType: panelType))
            return .branch(BranchData(
                orientation: orientation,
                first: self,
                second: newLeaf
            ))

        case .branch(var data):
            data.first = data.first.split(leafID: leafID, orientation: orientation, newTabIndex: newTabIndex, panelType: panelType)
            data.second = data.second.split(leafID: leafID, orientation: orientation, newTabIndex: newTabIndex, panelType: panelType)
            return .branch(data)
        }
    }

    /// Remove a leaf node by its ID. Returns nil if the tree becomes empty.
    func removeLeaf(id leafID: UUID) -> SplitNode? {
        switch self {
        case .leaf(let data):
            return data.id == leafID ? nil : self

        case .branch(let data):
            let firstResult = data.first.removeLeaf(id: leafID)
            let secondResult = data.second.removeLeaf(id: leafID)

            // If either child was removed, return the remaining one
            if firstResult == nil { return secondResult }
            if secondResult == nil { return firstResult }

            // Both still exist — reconstruct the branch
            var newData = data
            newData.first = firstResult!
            newData.second = secondResult!
            return .branch(newData)
        }
    }

    /// Update the split ratio for a specific branch.
    func updateRatio(branchID: UUID, ratio: CGFloat) -> SplitNode {
        switch self {
        case .leaf:
            return self
        case .branch(var data):
            if data.id == branchID {
                data.ratio = max(0.1, min(0.9, ratio))
                return .branch(data)
            }
            data.first = data.first.updateRatio(branchID: branchID, ratio: ratio)
            data.second = data.second.updateRatio(branchID: branchID, ratio: ratio)
            return .branch(data)
        }
    }

    /// Get the next leaf after the given leaf ID (for focus navigation).
    func nextLeaf(after leafID: UUID) -> LeafData? {
        let leaves = allLeaves
        guard let idx = leaves.firstIndex(where: { $0.id == leafID }) else { return nil }
        let nextIdx = (idx + 1) % leaves.count
        return leaves[nextIdx]
    }

    /// Get the previous leaf before the given leaf ID.
    func previousLeaf(before leafID: UUID) -> LeafData? {
        let leaves = allLeaves
        guard let idx = leaves.firstIndex(where: { $0.id == leafID }) else { return nil }
        let prevIdx = (idx - 1 + leaves.count) % leaves.count
        return leaves[prevIdx]
    }
}
